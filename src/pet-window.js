import { listCharacters, prepareCharacterAssets } from './characters.js'

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
 *   onClosed: () => void,
 *   logger?: Console,
 * }} options
 */
export function createPetWindow({ createHelper, environment, character, home, petsRoot, onSettingsChange, onClosed, logger = console }) {
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
  const options = () => {
    const root = characterRoot(character())
    return {
      env: { ...environment(), ...(root ? { DAFEIYU_ASSET_ROOT: root } : {}) },
      onSettingsChange,
      onClosed,
    }
  }

  let helper = createHelper(options())

  return {
    start: () => helper.start(),
    send: (message) => helper.send(message),
    stop: (reason) => helper.stop(reason),
    characters: () => listCharacters(petsRoot),
    hasCharacter: (id) => listCharacters(petsRoot).some((item) => item.id === id),
    /** Restart on the character now returned by `character()`. */
    restart() {
      helper.stop('character-change')
      helper = createHelper(options())
      helper.start()
    },
  }
}
