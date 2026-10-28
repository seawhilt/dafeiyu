import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CompanionMessageKind, createMessage } from './protocol.js'

// Subscription usage comes from Claude Code's own `/usage` command run in
// print mode: it is a local command (no model call, no tokens), uses Claude
// Code's login, and reports the same live numbers as the usage page.
// Hooks are disabled for the query: a slow user hook (session-start updaters
// and the like) can stall it for minutes, and the pet's own hooks would
// report these internal runs as user activity.
const USAGE_ARGS = Object.freeze([
  '-p', '/usage', '--output-format', 'json', '--no-session-persistence',
  '--settings', JSON.stringify({ disableAllHooks: true }),
])
const USAGE_TIMEOUT_MS = 30000
const MAX_OUTPUT_BYTES = 256 * 1024

const PATTERNS = Object.freeze({
  session: /Current session:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^\n]+))?/u,
  weekly: /Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^\n]+))?/u,
})

function windowOf(text, pattern) {
  const match = pattern.exec(text)
  if (!match) return undefined
  const percent = Math.min(100, Math.max(0, Number(match[1])))
  return { percent, resets: match[2]?.trim().slice(0, 80) }
}

/** Parse the text `/usage` prints; undefined when it has no usage lines. */
export function parseUsageReport(text) {
  if (typeof text !== 'string') return undefined
  const session = windowOf(text, PATTERNS.session)
  const weekly = windowOf(text, PATTERNS.weekly)
  if (!session && !weekly) return undefined
  return { session, weekly }
}

// The daemon may start from DSH, whose PATH can lack Claude Code; the native
// installer's location is tried next. DAFEIYU_CLAUDE overrides both.
export function claudeCommands(environment = process.env, home = homedir()) {
  if (environment.DAFEIYU_CLAUDE) return [environment.DAFEIYU_CLAUDE]
  return ['claude', join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]
}

/**
 * Run `claude -p /usage` and parse it. Rejects when Claude Code is missing,
 * not logged in to a subscription, or prints something unexpected.
 */
export async function queryClaudeUsage({ commands = claudeCommands(), run = execFile, timeoutMs = USAGE_TIMEOUT_MS } = {}) {
  let lastError
  for (const command of commands) {
    try {
      return await runUsage(command, run, timeoutMs)
    } catch (error) {
      lastError = error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw lastError
}

function runUsage(command, run, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = run(command, USAGE_ARGS, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      let result
      try {
        result = JSON.parse(stdout)?.result
      } catch {
        reject(new Error('claude /usage printed invalid JSON'))
        return
      }
      const usage = parseUsageReport(result)
      if (usage) resolve(usage)
      else reject(new Error('claude /usage reported no subscription usage'))
    })
    // Print mode otherwise waits 3 s for piped input.
    child?.stdin?.end()
  })
}

const formatPercent = (value) => `${Math.round(value)}%`

export function usageSummary(usage) {
  const parts = []
  if (usage?.session) parts.push(`会话 ${formatPercent(usage.session.percent)}`)
  if (usage?.weekly) parts.push(`本周 ${formatPercent(usage.weekly.percent)}`)
  return parts.length ? `Claude 额度 ${parts.join(' · ')}` : ''
}

// Reuses the balance slot of the protocol, so both helpers render it in the
// bubble footer without any change.
export function usageMessage(usage, now = Date.now()) {
  return createMessage(CompanionMessageKind.BALANCE, {
    status: 'ready',
    source: 'subscription',
    balances: [],
    usage,
    checkedAt: now,
    summary: usageSummary(usage),
  })
}
