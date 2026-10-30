// Agent products whose status reaches the pet through command hooks. Each
// entry is everything the daemon, the hook script and the settings page need
// to know about one product; adding a product means adding an entry here.
import { slimClaudeHookPayload, translateClaudeHook } from '../claude-adapter.js'
import { claudeIntegrationStatus, installClaudeIntegration, uninstallClaudeIntegration } from '../claude-hooks.js'
import { queryClaudeUsage } from '../claude-usage.js'

const DEFAULT_SOURCE = 'claude'

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   slim: (payload: unknown) => object | undefined,
 *   translate: (payload: object, seq?: number) => Array<object>,
 *   integration: {
 *     status: (path?: string) => object,
 *     install: (path?: string, paths?: object) => void,
 *     uninstall: (path?: string, paths?: object) => boolean,
 *   },
 *   usage?: { query: () => Promise<object> },
 * }} HookSource
 */

/** @type {Readonly<Record<string, HookSource>>} */
const HOOK_SOURCES = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    // Runs inside Claude Code's hook process: drops prompts and file contents.
    slim: slimClaudeHookPayload,
    translate: translateClaudeHook,
    integration: Object.freeze({
      status: claudeIntegrationStatus,
      install: installClaudeIntegration,
      uninstall: uninstallClaudeIntegration,
    }),
    usage: Object.freeze({ query: () => queryClaudeUsage() }),
  }),
})

export const HOOK_SOURCE_IDS = Object.freeze(Object.keys(HOOK_SOURCES))

/** @returns {HookSource | undefined} */
export function hookSource(id) {
  return Object.hasOwn(HOOK_SOURCES, id) ? HOOK_SOURCES[id] : undefined
}

/**
 * The `--source` the hook command was installed with. Hooks written before
 * the flag existed carry none and always came from Claude Code.
 * @param {string[]} argv arguments after the script path
 */
export function sourceArgument(argv) {
  const index = argv.indexOf('--source')
  return (index >= 0 && argv[index + 1]) || DEFAULT_SOURCE
}
