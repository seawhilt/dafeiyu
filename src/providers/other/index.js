// Any tool that can run a command on its own events: Gemini CLI, Kimi, Qoder
// and whatever comes next. The user adds the hook command to the tool; there
// is no config file of ours to write. Payloads use Claude Code's fields
// (session_id, cwd, tool_name), which most agent CLIs copied, and Gemini CLI's
// event names are mapped onto Claude's.
import { slimClaudeHookPayload, translateClaudeHook } from '../claude/adapter.js'
import { hookCommand } from '../json-hooks.js'

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u
const FALLBACK_NAME = 'other'

const CLAUDE_EVENTS = new Set([
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
const EVENT_ALIASES = Object.freeze({
  // Gemini CLI
  BeforeAgent: 'UserPromptSubmit',
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  AfterAgent: 'Stop',
  // Short words for a hand-written `--event`
  start: 'UserPromptSubmit',
  thinking: 'UserPromptSubmit',
  tool: 'PreToolUse',
  working: 'PreToolUse',
  waiting: 'PermissionRequest',
  done: 'Stop',
  idle: 'Stop',
  error: 'StopFailure',
  end: 'SessionEnd',
})

/** The tool's name as given to `--name`, or "other" when it is not a short slug. */
export function agentName(value) {
  const name = typeof value === 'string' ? value.toLowerCase() : ''
  return NAME_PATTERN.test(name) ? name : FALLBACK_NAME
}

function claudeEventOf(event) {
  if (CLAUDE_EVENTS.has(event)) return event
  return Object.hasOwn(EVENT_ALIASES, event) ? EVENT_ALIASES[event] : undefined
}

/**
 * A payload built from `--event` for a tool that cannot pass JSON on stdin.
 * @param {string} event
 * @param {{ cwd: string, sessionId?: string }} context
 */
export function eventPayload(event, { cwd, sessionId }) {
  if (typeof event !== 'string' || !event) return undefined
  return { hook_event_name: event, session_id: sessionId, cwd }
}

/** The command to paste into a tool's hook settings. */
export function otherHookCommand(name) {
  return `${hookCommand('other')} --name ${agentName(name)}`
}

// Runs inside the tool's hook process: only ids, cwd and the tool name leave it.
function slimOtherHookPayload(payload, { name } = {}) {
  if (!payload || typeof payload !== 'object') return undefined
  const event = claudeEventOf(payload.hook_event_name)
  if (!event) return undefined
  const slim = slimClaudeHookPayload({ ...payload, hook_event_name: event })
  return slim && { ...slim, agent: agentName(name) }
}

function translateOtherHook(payload, seq = Date.now()) {
  if (!payload || typeof payload !== 'object') return []
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'default'
  return translateClaudeHook({ ...payload, session_id: `${agentName(payload.agent)}:${sessionId}` }, seq)
}

export default Object.freeze({
  id: 'other',
  label: '其他工具',
  slim: slimOtherHookPayload,
  translate: translateOtherHook,
  setupNote: '把下面的命令加到工具的 hooks 里（Gemini CLI、Kimi、Qoder 等能在事件时执行命令的工具都行），--name 换成工具名。工具不传 JSON 时，可以在命令后加 --event start / tool / done / error。',
})
