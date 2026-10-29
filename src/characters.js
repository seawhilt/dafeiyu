import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Characters the pet can wear. The built-in whale-tail maid ships with the
// package; codex-pets packs (https://codex-pets.net, installed with
// `npx codex-pets add <id>`) live in <CODEX_HOME>/pets/<id>/ as pet.json plus
// one spritesheet.webp. A pack is translated into the pet manifest format so
// both helpers play it like any other character.

export const BUILTIN_CHARACTER = Object.freeze({ id: 'whale', name: '鲸尾女仆', source: 'builtin' })
const PET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SHEET_FILE = 'spritesheet.webp'
const MAX_SHEET_BYTES = 32 * 1024 * 1024
const SKIN_ROOT = fileURLToPath(new URL('../assets/skins/', import.meta.url))
const BUNDLED_PETS_ROOT = fileURLToPath(new URL('../assets/llm-pet/pets/', import.meta.url))
const XIAOLONGNV_PET_ID = 'chatgpt-chibi'
const SKINS = Object.freeze([
  ['basin', '饭盆头'],
  ['beret', '贝雷帽'],
  ['claude', 'Claude'],
  ['maid', '女仆装'],
  ['winter_blue', '冬日蓝'],
  ['winter_white', '冬日白'],
])
const SKIN_FRAME = Object.freeze({ width: 450, height: 600 })
// Calibrated to the built-in whale's ~268 px visible idle height (alpha >= 16).
// Each value is target visible height / this skin's tallest visible frame, so
// transparent padding in the source PNGs does not make a skin look oversized.
const SKIN_PIXEL_SCALES = Object.freeze({
  basin: 0.550,
  beret: 0.541,
  claude: 0.487,
  maid: 0.509,
  winter_blue: 0.527,
  winter_white: 0.486,
})
const LOOPING_SKIN_CLIPS = new Set(['idle', 'thinking', 'working', 'review', 'running_right', 'attention', 'tail', 'dragging'])
const SKIN_EMOTIONS = Object.freeze({
  idle: 'pet_stand.png',
  thinking: 'pet_face_confused.png',
  working: 'pet_face_happy.png',
  review: 'pet_face_confused.png',
  running_right: 'pet_stand.png',
  attention: 'pet_face_surprised.png',
  success: 'pet_face_happy.png',
  error: 'pet_face_sad.png',
  wave: 'pet_face_shy.png',
  jump: 'pet_face_surprised.png',
  head_pat: 'pet_face_shy.png',
  poke: 'pet_face_angry.png',
  tail: 'pet_stand.png',
  dragging: 'pet_stand.png',
  dragging_release: 'pet_face_surprised.png',
})

// Codex V1 atlas: 8 columns of 192x208 cells, one state per row.
const CELL = Object.freeze({ width: 192, height: 208 })
const ROWS = Object.freeze({
  idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8,
})
const FRAMES = Object.freeze({
  idle: 6, runningRight: 8, runningLeft: 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6, review: 6,
})
const FRAME_MS = 180
// Codex cells are about half the whale's frame; drawing them at 2x keeps the
// pet a similar size on screen.
const PIXEL_SCALE = 2
// Transparent space above a codex pet's head inside its cell, in cell pixels.
// Codex art often reaches the top of the cell (crests, ears), so the bubble
// tail stops at the cell's top edge.
const BUBBLE_HEADROOM = 0

export function codexPetsRoot(environment = process.env, home = homedir()) {
  return join(environment.CODEX_HOME || join(home, '.codex'), 'pets')
}

function listPetsAt(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const pets = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !PET_ID_PATTERN.test(entry.name)) continue
    try {
      const manifest = JSON.parse(readFileSync(join(root, entry.name, 'pet.json'), 'utf8'))
      const sheet = statSync(join(root, entry.name, SHEET_FILE))
      if (!sheet.isFile() || sheet.size > MAX_SHEET_BYTES) continue
      const name = typeof manifest?.displayName === 'string' && manifest.displayName.trim()
        ? manifest.displayName.trim().slice(0, 40)
        : entry.name
      pets.push({ id: `codex:${entry.name}`, name, source: 'codex-pets' })
    } catch {
      // An unreadable pack is skipped.
    }
  }
  return pets.sort((a, b) => a.id.localeCompare(b.id))
}

/** Installed codex pets with a readable pet.json and a spritesheet. */
export function listCodexPets(root = codexPetsRoot()) {
  return listPetsAt(root)
}

export function listCharacters(root = codexPetsRoot(), { includeSkins = root === codexPetsRoot() } = {}) {
  const skins = includeSkins ? SKINS.filter(([id]) => {
    try { return statSync(skinDirectory(id)).isDirectory() } catch { return false }
  }).map(([id, name]) => ({ id: `skin:${id}`, name, source: 'skin' })) : []
  if (!includeSkins) return [BUILTIN_CHARACTER, ...skins, ...listCodexPets(root)]
  const installedPets = listCodexPets(root)
    .filter((pet) => pet.id !== `codex:${XIAOLONGNV_PET_ID}`)
  const installedIds = new Set(installedPets.map((pet) => pet.id))
  const bundledPets = listPetsAt(BUNDLED_PETS_ROOT)
    .filter((pet) => pet.id !== `codex:${XIAOLONGNV_PET_ID}` && !installedIds.has(pet.id))
  return [
    BUILTIN_CHARACTER,
    ...skins,
    { id: 'skin:xiaolongnv', name: '小龙女（ChatGPT Q版）', source: 'llm-pet' },
    ...bundledPets,
    ...installedPets,
  ]
}

function skinDirectory(id) {
  return join(SKIN_ROOT, id)
}

/** Directory for a bundled `skin:<id>` character. */
export function skinDir(characterId) {
  const match = /^skin:([a-z0-9_]+)$/u.exec(characterId ?? '')
  return match && SKINS.some(([id]) => id === match[1]) ? skinDirectory(match[1]) : undefined
}

export function isSkin(characterId) {
  return skinDir(characterId) !== undefined
}

function skinManifest(id) {
  const clips = Object.fromEntries(Object.entries(SKIN_EMOTIONS).map(([clip, file]) => [clip, {
    frames: [file], frameMs: 1000, loop: LOOPING_SKIN_CLIPS.has(clip),
  }]))
  const sequenceDir = join(skinDirectory(id), 'seq')
  try {
    const sequence = readdirSync(sequenceDir).filter((file) => /^seq_\d+\.webp$/u.test(file)).sort()
    if (sequence.length > 0) {
      clips.idle = { frames: sequence.map((file) => `seq/${file}`), frameMs: 100, loop: true }
    }
  } catch {}
  const label = SKINS.find(([skinId]) => skinId === id)?.[1] ?? id
  return withAnimationOverrides({
    formatVersion: 1,
    characterId: `skin:${id}`,
    baseSize: SKIN_FRAME.width,
    maxFrameWidth: SKIN_FRAME.width,
    maxFrameHeight: SKIN_FRAME.height,
    maxClipWidth: SKIN_FRAME.width,
    pixelScale: SKIN_PIXEL_SCALES[id] ?? 0.5,
    bubbleHeadroom: 0,
    clips,
    stateMap: {
      IDLE: 'idle', THINKING: 'thinking', WORKING: 'working', WAITING: 'attention',
      SUCCESS: 'success', ERROR: 'error', DISCONNECTED: 'idle',
    },
    workingActivityMap: { searching: 'review', commanding: 'running_right', editing: 'working', testing: 'review', 'using-tool': 'working' },
    loopVariants: { thinking: ['thinking', 'review'], working: ['working', 'review', 'running_right'] },
    idleMicroClips: ['wave', 'jump'],
    idleMicroIntervalsMs: { quiet: [20000, 40000], normal: [8000, 15000], lively: [3000, 6000] },
    interactionCooldownMs: 1200,
    actionMenu: [{ label: '动作', items: [['害羞', 'wave', `${label}～`], ['惊喜', 'jump', '哇！']] }],
  }, skinDirectory(id))
}

const ANIMATION_FRAME_PATH = /^animations\/[a-z0-9_-]+\/[a-zA-Z0-9_.-]+\.(?:png|webp)$/u

function animationOverrides(directory) {
  try {
    const source = JSON.parse(readFileSync(join(directory, 'animations.json'), 'utf8'))
    if (source?.formatVersion !== 1 || !source.clips || typeof source.clips !== 'object' || Array.isArray(source.clips)) return {}
    return Object.fromEntries(Object.entries(source.clips).flatMap(([name, clip]) => {
      if (!/^[a-z][a-z0-9_-]*$/u.test(name) || !clip || typeof clip !== 'object' || !Array.isArray(clip.frames)) return []
      const frames = clip.frames.filter((file) => typeof file === 'string' && ANIMATION_FRAME_PATH.test(file))
      if (frames.length === 0 || frames.length !== clip.frames.length || frames.length > 2000) return []
      const frameMs = Number.isFinite(clip.frameMs) ? Math.max(20, Math.min(1000, clip.frameMs)) : 100
      return [[name, { frames, frameMs, loop: typeof clip.loop === 'boolean' ? clip.loop : LOOPING_SKIN_CLIPS.has(name) }]]
    }))
  } catch {
    return {}
  }
}

function withAnimationOverrides(manifest, directory) {
  if (!directory) return manifest
  return { ...manifest, clips: { ...manifest.clips, ...animationOverrides(directory) } }
}

function copyAnimationFrames(from, to) {
  const source = join(from, 'animations')
  try {
    for (const clip of readdirSync(source, { withFileTypes: true })) {
      if (!clip.isDirectory() || !/^[a-z][a-z0-9_-]*$/u.test(clip.name)) continue
      const target = join(to, 'animations', clip.name)
      mkdirSync(target, { recursive: true })
      for (const file of readdirSync(join(source, clip.name)).filter((name) => /^[a-zA-Z0-9_.-]+\.(?:png|webp)$/u.test(name)).sort()) {
        copyFileSync(join(source, clip.name, file), join(target, file))
      }
    }
  } catch {}
}

/** Resolve a bundled or installed pack directory for a model pet. */
export function codexPetDir(characterId, root = codexPetsRoot()) {
  const match = /^codex:([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(characterId ?? '')
  const slug = characterId === 'skin:xiaolongnv' ? XIAOLONGNV_PET_ID : match?.[1]
  if (!slug) return undefined
  const installed = join(root, slug)
  try {
    if (statSync(installed).isDirectory()) return installed
  } catch {}
  const bundled = join(BUNDLED_PETS_ROOT, slug)
  try {
    if (statSync(bundled).isDirectory()) return bundled
  } catch {}
  return match ? installed : undefined
}

function row(name, loop, frameName = name) {
  const count = FRAMES[name]
  return {
    frames: Array.from({ length: count }, (_, column) => `cell:${column}:${ROWS[name]}:${frameName}`),
    frameMs: FRAME_MS,
    loop,
  }
}

/** The pet manifest for a codex pack: its nine rows mapped onto pet states. */
export function codexManifest(displayName, directory) {
  const clips = {
    idle: row('idle', true),
    thinking: row('waiting', true),
    working: row('running', true),
    review: row('review', true),
    running_right: row('runningRight', true),
    attention: row('jumping', true),
    success: row('waving', false),
    error: row('failed', false),
    wave: row('waving', false),
    jump: row('jumping', false),
    run_right_once: row('runningRight', false),
    run_left_once: row('runningLeft', false),
    head_pat: row('waving', false),
    poke: row('jumping', false),
    tail: row('runningLeft', false),
    dragging: row('runningRight', true),
    dragging_release: row('jumping', false),
  }
  return withAnimationOverrides({
    formatVersion: 1,
    characterId: displayName,
    baseSize: CELL.width,
    maxFrameWidth: CELL.width,
    maxFrameHeight: CELL.height,
    maxClipWidth: CELL.width,
    pixelScale: PIXEL_SCALE,
    bubbleHeadroom: BUBBLE_HEADROOM,
    spritesheet: { file: SHEET_FILE, cellWidth: CELL.width, cellHeight: CELL.height },
    clips,
    stateMap: {
      IDLE: 'idle', THINKING: 'thinking', WORKING: 'working', WAITING: 'attention',
      SUCCESS: 'success', ERROR: 'error', DISCONNECTED: 'idle',
    },
    workingActivityMap: {
      searching: 'review', commanding: 'running_right', editing: 'working', testing: 'review', 'using-tool': 'working',
    },
    loopVariants: {
      thinking: ['thinking', 'review'],
      working: ['working', 'review', 'running_right'],
      review: ['review', 'working'],
      running_right: ['running_right', 'working'],
    },
    idleMicroClips: ['wave', 'jump', 'run_right_once', 'run_left_once'],
    idleMicroIntervalsMs: { quiet: [20000, 40000], normal: [8000, 15000], lively: [3000, 6000] },
    interactionCooldownMs: 1200,
    actionMenu: [{
      label: '动作',
      items: [
        ['挥手', 'wave', '嗨~'],
        ['跳一跳', 'jump', '蹦！'],
        ['向右跑', 'run_right_once', '冲呀~'],
        ['向左跑', 'run_left_once', '跑回来啦'],
      ],
    }],
  }, directory)
}

/**
 * Write a helper-ready asset root for a codex character under the daemon
 * home and return its path; the built-in character needs none.
 */
export function prepareCharacterAssets(characterId, { home, root = codexPetsRoot() }) {
  const bundledSkinDir = skinDir(characterId)
  if (bundledSkinDir) {
    const id = characterId.slice('skin:'.length)
    const target = join(home, 'characters', `skin-${id}`)
    const petTarget = join(target, 'pet')
    mkdirSync(join(petTarget, 'seq'), { recursive: true })
    for (const file of Object.values(SKIN_EMOTIONS)) copyFileSync(join(bundledSkinDir, file), join(petTarget, file))
    try {
      for (const file of readdirSync(join(bundledSkinDir, 'seq'))) {
        if (/^seq_\d+\.webp$/u.test(file)) copyFileSync(join(bundledSkinDir, 'seq', file), join(petTarget, 'seq', file))
      }
    } catch {}
    copyAnimationFrames(bundledSkinDir, petTarget)
    writeFileSync(join(target, 'pet-manifest.json'), `${JSON.stringify(skinManifest(id), null, 2)}\n`)
    return target
  }
  const dir = codexPetDir(characterId, root)
  if (!dir) return undefined
  const pack = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
  const name = characterId === 'skin:xiaolongnv'
    ? '小龙女（ChatGPT Q版）'
    : typeof pack?.displayName === 'string' ? pack.displayName.slice(0, 40) : characterId
  const target = join(home, 'characters', characterId.replace(':', '-'))
  mkdirSync(join(target, 'pet'), { recursive: true })
  copyFileSync(join(dir, SHEET_FILE), join(target, 'pet', SHEET_FILE))
  copyAnimationFrames(dir, join(target, 'pet'))
  writeFileSync(join(target, 'pet-manifest.json'), `${JSON.stringify(codexManifest(name, dir), null, 2)}\n`)
  return target
}

// The settings page asks for a preview whenever the list renders. A codex
// sheet can be tens of megabytes, so keep the last read per file and
// invalidate it when the pack is replaced.
const sheetCache = new Map()

/** The spritesheet of a codex character, for the settings page preview. */
export function codexSheet(characterId, root = codexPetsRoot()) {
  const dir = codexPetDir(characterId, root)
  if (!dir) return undefined
  const file = join(dir, SHEET_FILE)
  let mtime
  try {
    mtime = statSync(file).mtimeMs
    const cached = sheetCache.get(file)
    if (cached && cached.mtime === mtime) return cached.bytes
  } catch {
    return undefined
  }
  const bytes = readFileSync(file)
  sheetCache.set(file, { mtime, bytes })
  return bytes
}

/** Preview image for a bundled skin. */
export function skinPreview(characterId) {
  const dir = skinDir(characterId)
  if (!dir) return undefined
  return readFileSync(join(dir, 'pet_stand.png'))
}

export const CODEX_PREVIEW = Object.freeze({ cell: CELL, columns: FRAMES.idle, row: ROWS.idle, frameMs: FRAME_MS })

// petdex.dev hosts a public, MIT-licensed gallery of codex-format pets that
// is reachable where codex-pets.net is not. Downloads only ever come from its
// asset host.
const PETDEX_ASSETS = 'https://assets.petdex.dev/community'
const MAX_PET_JSON_BYTES = 64 * 1024
const DOWNLOAD_TIMEOUT_MS = 60000

/** Accept a pet name or any petdex link and return the pet's slug. */
export function petdexSlug(input) {
  const text = String(input ?? '').trim()
  let candidate = text
  if (/^https?:\/\//u.test(text)) {
    let url
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (!/(^|\.)petdex\.dev$/u.test(url.hostname)) return undefined
    const parts = url.pathname.split('/').filter(Boolean)
    candidate = parts.at(-1) === 'spritesheet.webp' || parts.at(-1) === 'pet.json' ? parts.at(-2) : parts.at(-1)
  }
  candidate = String(candidate ?? '').toLowerCase()
  return PET_ID_PATTERN.test(candidate) ? candidate : undefined
}

async function download(url, maxBytes, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (response.status === 404) throw Object.assign(new Error('petdex 上没有这个宠物'), { code: 'NOT_FOUND' })
  if (!response.ok) throw new Error(`petdex 下载失败（${response.status}）`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error('文件太大，已拒绝')
  return bytes
}

/**
 * Download a pet from petdex into the codex pets directory and return its
 * character id. The sheet must be a WebP and pet.json a JSON object.
 */
export async function installPetdexPet(input, { root = codexPetsRoot(), fetchImpl = fetch } = {}) {
  const slug = petdexSlug(input)
  if (!slug) throw Object.assign(new Error('请填写 petdex 上的宠物名或链接'), { code: 'BAD_NAME' })
  const base = `${PETDEX_ASSETS}/${slug}`
  const manifestBytes = await download(`${base}/pet.json`, MAX_PET_JSON_BYTES, fetchImpl)
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('pet.json 格式不对')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('pet.json 格式不对')
  const sheet = await download(`${base}/${SHEET_FILE}`, MAX_SHEET_BYTES, fetchImpl)
  if (sheet.subarray(0, 4).toString('latin1') !== 'RIFF' || sheet.subarray(8, 12).toString('latin1') !== 'WEBP') {
    throw new Error('精灵图不是 WebP，已拒绝')
  }
  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName.slice(0, 40) : slug
  const target = join(root, slug)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, SHEET_FILE), sheet)
  writeFileSync(join(target, 'pet.json'), `${JSON.stringify({ id: slug, displayName, source: 'petdex.dev' }, null, 2)}\n`)
  return `codex:${slug}`
}
