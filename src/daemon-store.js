import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeBubbleText } from './bubble-text.js'
import { PROVIDER_IDS } from './provider-hub.js'

export function daemonHome(environment = process.env) {
  return environment.DAFEIYU_HOME || join(homedir(), '.dafeiyu')
}

export function daemonPaths(home = daemonHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    runtime: join(home, 'daemon.json'),
    lock: join(home, 'daemon.lock'),
    log: join(home, 'daemon.log'),
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  provider: null,
  deepseekSeen: false,
  scale: 0.6,
  bubbleScale: 1,
  activityLevel: 'normal',
  reducedMotion: false,
  soundEnabled: true,
  bubbleMode: 'auto',
  bubbleStates: Object.freeze(['SUCCESS', 'ERROR', 'WAITING']),
  includeSubagents: false,
  whisperLevel: 'low',
  character: 'whale',
  bubbleText: Object.freeze({}),
})

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback)

/** Accept only known keys with valid values; anything else falls back to defaults. */
export function sanitizeSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const d = DEFAULT_SETTINGS
  return {
    provider: oneOf(raw.provider, PROVIDER_IDS, d.provider),
    deepseekSeen: raw.deepseekSeen === true,
    scale: clamp(raw.scale, 0.55, 1.4, d.scale),
    bubbleScale: clamp(raw.bubbleScale, 0.8, 1.2, d.bubbleScale),
    activityLevel: oneOf(raw.activityLevel, ['quiet', 'normal', 'lively'], d.activityLevel),
    reducedMotion: raw.reducedMotion === true,
    soundEnabled: raw.soundEnabled !== false,
    bubbleMode: oneOf(raw.bubbleMode, ['auto', 'always', 'hidden', 'custom'], d.bubbleMode),
    bubbleStates: Array.isArray(raw.bubbleStates)
      ? raw.bubbleStates.filter((item) => typeof item === 'string').slice(0, 8)
      : [...d.bubbleStates],
    includeSubagents: raw.includeSubagents === true,
    whisperLevel: oneOf(raw.whisperLevel, ['off', 'low', 'high'], d.whisperLevel),
    character: typeof raw.character === 'string' && /^(?:whale|codex:[a-z0-9]+(?:-[a-z0-9]+)*|skin:(?:basin|beret|claude|maid|winter_blue|winter_white))$/u.test(raw.character)
      ? raw.character
      : d.character,
    bubbleText: sanitizeBubbleText(raw.bubbleText),
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path, value, mode) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(temp, path)
  if (mode !== undefined) chmodSync(path, mode)
}

export function loadSettings(paths) {
  return sanitizeSettings(readJson(paths.config))
}

export function saveSettings(paths, settings) {
  mkdirSync(paths.home, { recursive: true })
  const next = sanitizeSettings(settings)
  writeJsonAtomic(paths.config, next)
  return next
}

export function readRuntime(paths) {
  const value = readJson(paths.runtime)
  if (!value || !Number.isInteger(value.port) || typeof value.token !== 'string') return undefined
  return value
}

// The token keeps other local users and web pages from steering the pet; the
// file is readable by its owner only.
export function writeRuntime(paths, runtime) {
  mkdirSync(paths.home, { recursive: true })
  writeJsonAtomic(paths.runtime, runtime, 0o600)
}
