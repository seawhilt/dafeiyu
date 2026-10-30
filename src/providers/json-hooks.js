// Hook installer for products that keep hooks in a JSON file under `hooks`:
// - grouped (Claude Code, Codex): { hooks: { <Event>: [{ hooks: [{ type, command }] }] } }
// - flat (Cursor):                { hooks: { <event>: [{ command }] } }
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOOK_MARKER = 'dafeiyu-hook'
const DEFAULT_TIMEOUT_SECONDS = 5

const here = dirname(fileURLToPath(import.meta.url))
export const hookScriptPath = resolve(here, '..', '..', 'bin', 'dafeiyu-hook.mjs')

/** The command a product runs for every event; `--source` names the product. */
export function hookCommand(source, nodePath = process.execPath, scriptPath = hookScriptPath) {
  return `"${nodePath}" "${scriptPath}" --source ${source}`
}

const isOurs = (hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)
const isGroup = (entry) => Array.isArray(entry?.hooks)

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
      .filter((entry) => !isOurs(entry))
      .map((entry) => (isGroup(entry) ? { ...entry, hooks: entry.hooks.filter((hook) => !isOurs(hook)) } : entry))
      .filter((entry) => !isGroup(entry) || entry.hooks.length > 0)
    if (kept.length > 0) nextHooks[event] = kept
  }
  return { ...settings, hooks: nextHooks }
}

/**
 * Idempotent: existing dafeiyu entries are replaced, other hooks are kept.
 * @param {{ layout?: 'grouped' | 'flat', timeout?: number }} [options]
 */
export function withDafeiyuHooks(settings, events, command, { layout = 'grouped', timeout = DEFAULT_TIMEOUT_SECONDS } = {}) {
  const base = withoutDafeiyuHooks(settings ?? {})
  const hooks = { ...base.hooks }
  const entry = layout === 'flat'
    ? { command, timeout }
    : { hooks: [{ type: 'command', command, timeout }] }
  for (const event of events) hooks[event] = [...(hooks[event] ?? []), entry]
  return { ...base, hooks }
}

export function hasDafeiyuHooks(settings) {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return false
  return Object.values(hooks).some((entries) => Array.isArray(entries)
    && entries.some((entry) => isOurs(entry) || (isGroup(entry) && entry.hooks.some(isOurs))))
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

function fileMode(path, fallback = 0o600) {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return fallback
  }
}

function writePrivateFile(path, data, mode) {
  writeFileSync(path, data, { mode })
  // writeFileSync applies the process umask on creation; restore the intended
  // mode explicitly so a 0600 settings file never becomes world-readable.
  try { chmodSync(path, mode) } catch {}
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true })
  const mode = fileMode(path)
  // Back up only a file without our entries, so reinstalling never replaces
  // the user's original with an already-modified copy.
  if (existsSync(path)) {
    const original = readFileSync(path)
    if (!original.includes(HOOK_MARKER)) writePrivateFile(`${path}.dafeiyu.bak`, original, mode)
  }
  const temp = `${path}.${process.pid}.tmp`
  writePrivateFile(temp, `${JSON.stringify(settings, null, 2)}\n`, mode)
  renameSync(temp, path)
}

/**
 * @param {{
 *   source: string,
 *   events: readonly string[],
 *   settingsPath: () => string,
 *   layout?: 'grouped' | 'flat',
 *   timeout?: number,
 *   defaults?: object,  top-level fields the file must have, e.g. a schema version
 * }} options
 */
export function createJsonHooksIntegration({ source, events, settingsPath, layout = 'grouped', timeout, defaults = {} }) {
  return Object.freeze({
    settingsPath,
    /** What the settings page shows; never throws. */
    status(path = settingsPath()) {
      try {
        return { settingsPath: path, readable: true, installed: hasDafeiyuHooks(readSettings(path)) }
      } catch (error) {
        return { settingsPath: path, readable: false, error: error.message, installed: false }
      }
    },
    install(path = settingsPath(), command = hookCommand(source)) {
      writeSettings(path, withDafeiyuHooks({ ...defaults, ...readSettings(path) }, events, command, { layout, timeout }))
    },
    /** @returns {boolean} whether anything was removed */
    uninstall(path = settingsPath()) {
      const current = readSettings(path)
      if (!hasDafeiyuHooks(current)) return false
      writeSettings(path, withoutDafeiyuHooks(current))
      return true
    },
  })
}
