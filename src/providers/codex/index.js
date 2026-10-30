// Codex hooks use Claude Code's event names and payload fields
// (session_id, cwd, tool_name, tool_use_id, agent_id), so the Claude adapter
// does almost all the work. Codex has no failure event; Interrupt is the
// user stopping a turn.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hookEventBuilders, slimClaudeHookPayload, translateClaudeHook } from '../claude/adapter.js'
import { createJsonHooksIntegration } from '../json-hooks.js'

export const CODEX_HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
  'SubagentStop',
  'SessionEnd',
])
// SessionEnd and Interrupt hooks may run for at most 3 s.
const CODEX_HOOK_TIMEOUT_SECONDS = 3

export function codexHooksPath(environment = process.env) {
  return join(environment.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json')
}

function translateCodexHook(payload, seq = Date.now()) {
  if (payload?.hook_event_name !== 'Interrupt') return translateClaudeHook(payload, seq)
  const { event, decided } = hookEventBuilders(payload, seq)
  return [decided(), event('turn/end', { reason: { kind: 'aborted' } })]
}

export default Object.freeze({
  id: 'codex',
  label: 'Codex',
  slim: slimClaudeHookPayload,
  translate: translateCodexHook,
  setupNote: '新写入的 hooks 要在 Codex 里运行 /hooks 审核并信任一次才会生效。',
  integration: createJsonHooksIntegration({
    source: 'codex',
    events: CODEX_HOOK_EVENTS,
    settingsPath: () => codexHooksPath(),
    timeout: CODEX_HOOK_TIMEOUT_SECONDS,
  }),
})
