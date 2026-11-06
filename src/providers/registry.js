// Agent products whose status reaches the pet through command hooks. Each
// entry is everything the daemon, the hook script and the settings page need
// to know about one product; adding a product means adding an entry here and
// a channel in provider-hub.js.
import claude from './claude/index.js'
import codex from './codex/index.js'
import cursor from './cursor/index.js'
import other from './other/index.js'

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   slim: (payload: unknown) => object | undefined,
 *   translate: (payload: object, seq?: number) => Array<object>,
 *   integration?: {
 *     settingsPath: () => string,
 *     status: (path?: string) => { settingsPath: string, readable: boolean, installed: boolean, error?: string },
 *     install: (path?: string) => void,
 *     uninstall: (path?: string) => boolean,
 *   },  absent when the user adds the command to the tool by hand
 *   usage?: { query: () => Promise<object> },
 *   setupNote?: string,  shown in the settings page next to install
 * }} HookSource
 */

/** @type {Readonly<Record<string, HookSource>>} */
const HOOK_SOURCES = Object.freeze({ claude, codex, cursor, other })

export const HOOK_SOURCE_IDS = Object.freeze(Object.keys(HOOK_SOURCES))

/** @returns {HookSource | undefined} */
export function hookSource(id) {
  return Object.hasOwn(HOOK_SOURCES, id) ? HOOK_SOURCES[id] : undefined
}

/** Sources dafeiyu can write hooks for. */
export const INSTALLABLE_SOURCE_IDS = Object.freeze(HOOK_SOURCE_IDS.filter((id) => HOOK_SOURCES[id].integration))

/**
 * The value after `flag` in the hook command, e.g. `--source`.
 * @param {string[]} argv arguments after the script path
 * @returns {string | undefined}
 */
export function hookArgument(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

export const sourceArgument = (argv) => hookArgument(argv, '--source')
