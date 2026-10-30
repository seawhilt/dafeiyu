import { homedir } from 'node:os'
import { join } from 'node:path'
import { createJsonHooksIntegration } from '../json-hooks.js'
import { slimClaudeHookPayload, translateClaudeHook } from './adapter.js'
import { queryClaudeUsage } from './usage.js'

export const CLAUDE_HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
])

export function claudeSettingsPath(environment = process.env) {
  return join(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

export default Object.freeze({
  id: 'claude',
  label: 'Claude',
  // Runs inside Claude Code's hook process: drops prompts and file contents.
  slim: slimClaudeHookPayload,
  translate: translateClaudeHook,
  integration: createJsonHooksIntegration({
    source: 'claude',
    events: CLAUDE_HOOK_EVENTS,
    settingsPath: () => claudeSettingsPath(),
  }),
  usage: Object.freeze({ query: () => queryClaudeUsage() }),
})
