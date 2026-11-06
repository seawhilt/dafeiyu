import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeBubbleText } from '../core/bubble-text.js'
import { isProviderId, normalizeOrder } from '../hub/provider-hub.js'
import {
  ANIMATION_GAP_MAX_SECONDS, BUBBLE_SCALE_RANGE, DEFAULT_SCALE, OPACITY_RANGE, PLAYBACK_SPEEDS, SCALE_RANGE, THROW_STRENGTHS,
} from '../core/pet-settings.js'

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
  // Sources the user switched off stay set up but never reach the pet.
  sources: Object.freeze({ order: Object.freeze([]), disabled: Object.freeze([]) }),
  deepseekSeen: false,
  scale: DEFAULT_SCALE,
  bubbleScale: 1,
  petOpacity: 100,
  playbackSpeed: 1,
  animationGap: 0,
  powerSaving: false,
  noMove: false,
  // Throwing was this project's first motion feature, so it stays on.
  dragPhysics: true,
  dropGravity: false,
  throwStrength: 'standard',
  slingshot: true,
  lockPosition: false,
  shiftDrag: false,
  edgeProbe: true,
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

/** Display and motion settings the pet window applies as they change. */
export const PET_MOTION_SETTINGS = Object.freeze([
  'petOpacity', 'playbackSpeed', 'animationGap', 'powerSaving', 'noMove', 'dragPhysics', 'dropGravity',
  'throwStrength', 'slingshot', 'lockPosition', 'shiftDrag', 'edgeProbe',
])

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback)

function sanitizeSources(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const disabled = Array.isArray(raw.disabled) ? [...new Set(raw.disabled.filter(isProviderId))] : []
  return { order: normalizeOrder(raw.order), disabled }
}

/** Accept only known keys with valid values; anything else falls back to defaults. */
export function sanitizeSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const d = DEFAULT_SETTINGS
  return {
    sources: sanitizeSources(raw.sources),
    deepseekSeen: raw.deepseekSeen === true,
    scale: clamp(raw.scale, SCALE_RANGE.min, SCALE_RANGE.max, d.scale),
    bubbleScale: clamp(raw.bubbleScale, BUBBLE_SCALE_RANGE.min, BUBBLE_SCALE_RANGE.max, d.bubbleScale),
    petOpacity: Math.round(clamp(raw.petOpacity, OPACITY_RANGE.min, OPACITY_RANGE.max, d.petOpacity)),
    playbackSpeed: oneOf(raw.playbackSpeed, PLAYBACK_SPEEDS, d.playbackSpeed),
    animationGap: clamp(raw.animationGap, 0, ANIMATION_GAP_MAX_SECONDS, d.animationGap),
    powerSaving: raw.powerSaving === true,
    noMove: raw.noMove === true,
    dragPhysics: raw.dragPhysics !== false,
    dropGravity: raw.dropGravity === true,
    throwStrength: oneOf(raw.throwStrength, THROW_STRENGTHS, d.throwStrength),
    slingshot: raw.slingshot !== false,
    lockPosition: raw.lockPosition === true,
    shiftDrag: raw.shiftDrag === true,
    edgeProbe: raw.edgeProbe !== false,
    activityLevel: oneOf(raw.activityLevel, ['quiet', 'normal', 'lively'], d.activityLevel),
    reducedMotion: raw.reducedMotion === true,
    soundEnabled: raw.soundEnabled !== false,
    bubbleMode: oneOf(raw.bubbleMode, ['auto', 'always', 'hidden', 'custom'], d.bubbleMode),
    bubbleStates: Array.isArray(raw.bubbleStates)
      ? raw.bubbleStates.filter((item) => typeof item === 'string').slice(0, 8)
      : [...d.bubbleStates],
    includeSubagents: raw.includeSubagents === true,
    whisperLevel: oneOf(raw.whisperLevel, ['off', 'low', 'high'], d.whisperLevel),
    character: typeof raw.character === 'string' && /^(?:whale|codex:[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(raw.character)
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
