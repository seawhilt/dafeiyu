import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Characters the pet can wear. The built-in whale-tail maid ships with the
// package; codex-pets packs (https://codex-pets.net, installed with
// `npx codex-pets add <id>`) live in <CODEX_HOME>/pets/<id>/ as pet.json plus
// one spritesheet.webp. A pack is translated into the pet manifest format so
// both helpers play it like any other character.

export const BUILTIN_CHARACTER = Object.freeze({ id: 'whale', name: '鲸尾女仆', source: 'builtin' })
const PET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SHEET_FILE = 'spritesheet.webp'
const MAX_SHEET_BYTES = 32 * 1024 * 1024

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

/** Installed codex pets with a readable pet.json and a spritesheet. */
export function listCodexPets(root = codexPetsRoot()) {
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

export function listCharacters(root = codexPetsRoot()) {
  return [BUILTIN_CHARACTER, ...listCodexPets(root)]
}

/** The pack directory for a `codex:<id>` character, or undefined. */
export function codexPetDir(characterId, root = codexPetsRoot()) {
  const match = /^codex:([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(characterId ?? '')
  return match ? join(root, match[1]) : undefined
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
export function codexManifest(displayName) {
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
  return {
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
  }
}

/**
 * Write a helper-ready asset root for a codex character under the daemon
 * home and return its path; the built-in character needs none.
 */
export function prepareCharacterAssets(characterId, { home, root = codexPetsRoot() }) {
  const dir = codexPetDir(characterId, root)
  if (!dir) return undefined
  const pack = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
  const name = typeof pack?.displayName === 'string' ? pack.displayName.slice(0, 40) : characterId
  const target = join(home, 'characters', characterId.replace(':', '-'))
  mkdirSync(join(target, 'pet'), { recursive: true })
  copyFileSync(join(dir, SHEET_FILE), join(target, 'pet', SHEET_FILE))
  writeFileSync(join(target, 'pet-manifest.json'), `${JSON.stringify(codexManifest(name), null, 2)}\n`)
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
