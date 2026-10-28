import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonPaths } from './daemon-store.js'

export const HOOK_MARKER = 'dafeiyu-hook'
// Marks the status line wrapper older builds installed.
export const STATUSLINE_MARKER = 'dafeiyu-statusline'
export const HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
])
const HOOK_TIMEOUT_SECONDS = 5

const here = dirname(fileURLToPath(import.meta.url))
export const hookScriptPath = resolve(here, '..', 'bin', 'dafeiyu-hook.mjs')

export function claudeSettingsPath(environment = process.env) {
  return join(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

export function hookCommand(nodePath = process.execPath, scriptPath = hookScriptPath) {
  return `"${nodePath}" "${scriptPath}"`
}

const isOurs = (hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)

/** @returns {object} settings without any dafeiyu hook entries */
export function withoutDafeiyuHooks(settings) {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return { ...settings }
  const nextHooks = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups
      continue
    }
    const kept = groups
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
    if (kept.length > 0) nextHooks[event] = kept
  }
  return { ...settings, hooks: nextHooks }
}

/** Idempotent: existing dafeiyu entries are replaced, other hooks are kept. */
export function withDafeiyuHooks(settings, command = hookCommand()) {
  const base = withoutDafeiyuHooks(settings ?? {})
  const hooks = { ...base.hooks }
  for (const event of HOOK_EVENTS) {
    const entry = { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }
    hooks[event] = [...(hooks[event] ?? []), { hooks: [entry] }]
  }
  return { ...base, hooks }
}

export function hasDafeiyuHooks(settings) {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return false
  return Object.values(hooks).some((groups) => Array.isArray(groups)
    && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isOurs)))
}

function readSettings(path) {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  if (!text.trim()) return {}
  // Refuse to rewrite a file we cannot parse; overwriting it would lose the
  // user's configuration.
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`)
  return value
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true })
  // Back up only a file without our entries, so reinstalling never replaces
  // the user's original with an already-modified copy.
  if (existsSync(path)) {
    const original = readFileSync(path)
    if (!original.includes(HOOK_MARKER) && !original.includes(STATUSLINE_MARKER)) writeFileSync(`${path}.dafeiyu.bak`, original)
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`)
  renameSync(temp, path)
}

export function claudeHooksInstalled(path = claudeSettingsPath()) {
  try {
    return hasDafeiyuHooks(readSettings(path))
  } catch {
    return false
  }
}

export function installClaudeHooks(path = claudeSettingsPath(), command = hookCommand()) {
  writeSettings(path, withDafeiyuHooks(readSettings(path), command))
}

export function uninstallClaudeHooks(path = claudeSettingsPath()) {
  const current = readSettings(path)
  if (!hasDafeiyuHooks(current)) return false
  writeSettings(path, withoutDafeiyuHooks(current))
  return true
}

// Earlier builds wrapped the status line to read subscription usage. The
// wrapper is gone; installing or removing the integration puts the user's
// original status line (kept in the daemon home) back.
const isOurStatusLine = (statusLine) => typeof statusLine?.command === 'string' && statusLine.command.includes(STATUSLINE_MARKER)
const previousStatusLinePath = (paths) => join(paths.home, 'statusline.json')

function previousStatusLine(paths) {
  try {
    return JSON.parse(readFileSync(previousStatusLinePath(paths), 'utf8'))?.statusLine ?? null
  } catch {
    return null
  }
}

function withoutDafeiyuStatusLine(current, paths) {
  if (!isOurStatusLine(current.statusLine)) return current
  const previous = previousStatusLine(paths)
  const { statusLine: _ours, ...rest } = current
  return previous ? { ...rest, statusLine: previous } : rest
}

function forgetPreviousStatusLine(paths) {
  rmSync(previousStatusLinePath(paths), { force: true })
}

/** Install the hooks and restore a status line left wrapped by an earlier build. */
export function installClaudeIntegration(path = claudeSettingsPath(), paths = daemonPaths()) {
  const current = readSettings(path)
  writeSettings(path, withDafeiyuHooks(withoutDafeiyuStatusLine(current, paths)))
  if (isOurStatusLine(current.statusLine)) forgetPreviousStatusLine(paths)
}

/** @returns {boolean} whether anything was removed */
export function uninstallClaudeIntegration(path = claudeSettingsPath(), paths = daemonPaths()) {
  const current = readSettings(path)
  if (!hasDafeiyuHooks(current) && !isOurStatusLine(current.statusLine)) return false
  writeSettings(path, withoutDafeiyuStatusLine(withoutDafeiyuHooks(current), paths))
  if (isOurStatusLine(current.statusLine)) forgetPreviousStatusLine(paths)
  return true
}

/** What the settings page shows for Claude. */
export function claudeIntegrationStatus(path = claudeSettingsPath()) {
  try {
    return { settingsPath: path, readable: true, hooksInstalled: hasDafeiyuHooks(readSettings(path)) }
  } catch (error) {
    return { settingsPath: path, readable: false, error: error.message, hooksInstalled: false }
  }
}
