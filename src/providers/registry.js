// Agent products whose status reaches the pet through command hooks. Each
// entry is everything the daemon, the hook script and the settings page need
// to know about one product; adding a product means adding an entry here and
// a channel in provider-hub.js.
import claude from './claude/index.js'
import codex from './codex/index.js'
import cursor from './cursor/index.js'

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   slim: (payload: unknown) => object | undefined,
 *   translate: (payload: object, seq?: number) => Array<object>,
 *   integration: {
 *     settingsPath: () => string,
 *     status: (path?: string) => { settingsPath: string, readable: boolean, installed: boolean, error?: string },
 *     install: (path?: string) => void,
 *     uninstall: (path?: string) => boolean,
 *   },
 *   usage?: { query: () => Promise<object> },
 *   setupNote?: string,  shown in the settings page next to install
 * }} HookSource
 */

/** @type {Readonly<Record<string, HookSource>>} */
const HOOK_SOURCES = Object.freeze({ claude, codex, cursor })

export const HOOK_SOURCE_IDS = Object.freeze(Object.keys(HOOK_SOURCES))

/** @returns {HookSource | undefined} */
export function hookSource(id) {
  return Object.hasOwn(HOOK_SOURCES, id) ? HOOK_SOURCES[id] : undefined
}

/**
 * The `--source` the hook command was installed with.
 * @param {string[]} argv arguments after the script path
 * @returns {string | undefined}
 */
export function sourceArgument(argv) {
  const index = argv.indexOf('--source')
  return index >= 0 ? argv[index + 1] : undefined
}
