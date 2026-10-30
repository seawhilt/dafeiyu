// Cursor agent hooks: { version: 1, hooks: { <event>: [{ command }] } }.
//
// Only hooks that cannot block the agent are registered. Permission hooks
// (beforeShellExecution, beforeMCPExecution) and preToolUse expect a decision
// on stdout, and this hook prints nothing. Without a "tool started" event the
// last finished tool stands in for what the agent is working on.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isUserQuestionTool } from '../../core/companion-reducer.js'
import { normalizeToolName } from '../claude/adapter.js'
import { createJsonHooksIntegration } from '../json-hooks.js'

export const CURSOR_HOOK_EVENTS = Object.freeze([
  'beforeSubmitPrompt',
  'postToolUse',
  'postToolUseFailure',
  'stop',
  'sessionEnd',
])
const STOP_REASONS = Object.freeze({ completed: 'completed', aborted: 'aborted', error: 'error' })
const TEXT_LIMIT = 512

export function cursorHooksPath(home = homedir()) {
  return join(home, '.cursor', 'hooks.json')
}

const pick = (payload, key) => (typeof payload[key] === 'string' ? payload[key].slice(0, TEXT_LIMIT) : undefined)

// Runs inside Cursor's hook process: prompts, tool input and output, the
// response text and the user's e-mail never leave it.
function slimCursorHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []
  return {
    hook_event_name: pick(payload, 'hook_event_name'),
    conversation_id: pick(payload, 'conversation_id'),
    cwd: pick(payload, 'cwd') ?? (typeof roots[0] === 'string' ? roots[0].slice(0, TEXT_LIMIT) : undefined),
    tool_name: pick(payload, 'tool_name'),
    tool_use_id: pick(payload, 'tool_use_id'),
    failure_type: pick(payload, 'failure_type'),
    status: pick(payload, 'status'),
  }
}

function translateCursorHook(payload, seq = Date.now()) {
  if (!payload || typeof payload !== 'object') return []
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
  const session = { cwd, header: { id: String(payload.conversation_id || 'cursor-conversation'), cwd } }
  const event = (type, data = {}) => ({ type: 'event', session, event: { type, seq, data } })
  const name = normalizeToolName(payload.tool_name)
  const callId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : `cursor-${seq}`

  switch (payload.hook_event_name) {
    case 'beforeSubmitPrompt':
      return [event('turn/start')]
    case 'postToolUse':
      // A question tool has already been answered by the time it reports.
      return isUserQuestionTool(name) ? [] : [event('tool/call', { name, callId })]
    case 'postToolUseFailure':
      return [
        event('tool/call', { name, callId }),
        event('tool/result', { callId, error: { code: payload.failure_type || 'tool-failed' } }),
      ]
    case 'stop':
      return [event('turn/end', { reason: { kind: STOP_REASONS[payload.status] ?? 'completed' } })]
    case 'sessionEnd':
      return [{ type: 'dispose', session }]
    default:
      return []
  }
}

export default Object.freeze({
  id: 'cursor',
  label: 'Cursor',
  slim: slimCursorHookPayload,
  translate: translateCursorHook,
  setupNote: 'Cursor 不提供安全的「工具开始」事件，桌宠用刚完成的工具显示它在做什么；也没有「等你确认」事件。',
  integration: createJsonHooksIntegration({
    source: 'cursor',
    events: CURSOR_HOOK_EVENTS,
    settingsPath: () => cursorHooksPath(),
    layout: 'flat',
    defaults: { version: 1 },
  }),
})
