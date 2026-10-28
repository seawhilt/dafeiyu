import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listCharacters, prepareCharacterAssets } from './characters.js'

const packageAssets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

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
  // to the built-in whale.
  const characterRoot = (id) => {
    if (id === 'whale') return undefined
    try {
      return prepareCharacterAssets(id, { home, root: petsRoot })
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
