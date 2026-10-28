import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexPetDir, listCharacters, prepareCharacterAssets } from './characters.js'

const packageAssets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const SHEET_FILE = 'spritesheet.webp'

// The pet window: one helper process playing the selected character.
// Switching character restarts the helper with that character's frames.

/**
 * @param {{
 *   createHelper: (options: object) => { start(): void, send(message: object): void, stop(reason?: string): void },
 *   environment: () => Record<string, string>,
 *   character: () => string,
 *   home: string,
 *   petsRoot: string,
 *   onSettingsChange: (report: object) => void,
 *   onInput?: (report: object) => void,
 *   onPass?: (report: object) => void,
 *   onClosed: () => void,
 *   logger?: Console,
 * }} options
 */
export function createPetWindow({
  createHelper, environment, character, home, petsRoot, onSettingsChange, onInput, onPass, onClosed, logger = console,
}) {
  // A codex character needs a prepared asset root; a missing pack falls back
  // to the built-in whale. The cache is keyed by the source sheet's mtime so
  // reinstalling a pack is picked up without copying it again on every call.
  const prepared = new Map()
  const characterRoot = (id) => {
    if (id === 'whale') return undefined
    let mtime
    try {
      const directory = codexPetDir(id, petsRoot)
      mtime = directory ? statSync(join(directory, SHEET_FILE)).mtimeMs : undefined
    } catch {}
    const cached = prepared.get(id)
    if (cached && mtime !== undefined && cached.mtime === mtime) return cached.root
    try {
      const next = prepareCharacterAssets(id, { home, root: petsRoot })
      prepared.set(id, { root: next, mtime })
      return next
    } catch (error) {
      logger.warn?.(`dafeiyu could not load character ${id}: ${error.message}`)
      return undefined
    }
  }
  let root = characterRoot(character())
  const options = () => ({
    env: { ...environment(), ...(root ? { DAFEIYU_ASSET_ROOT: root } : {}) },
    onSettingsChange,
    onInput,
    onPass,
    onClosed,
  })

  let helper = createHelper(options())

  return {
    start: () => helper.start(),
    send: (message) => helper.send(message),
    stop: (reason) => helper.stop(reason),
    characters: () => listCharacters(petsRoot),
    hasCharacter: (id) => listCharacters(petsRoot).some((item) => item.id === id),
    /** Whether the character's assets can actually be prepared for the helper. */
    canLoad: (id) => id === 'whale' || characterRoot(id) !== undefined,
    /** The clips of the character on screen. */
    manifest: () => JSON.parse(readFileSync(join(root ?? packageAssets, 'pet-manifest.json'), 'utf8')),
    /** Restart on the character now returned by `character()`. */
    restart() {
      helper.stop('character-change')
      root = characterRoot(character())
      helper = createHelper(options())
      helper.start()
    },
  }
}
