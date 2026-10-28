// Translates Claude Code hook payloads into the DSH session-event shape the
// CompanionReducer already understands, so both providers share one state
// machine instead of two diverging ones.

// Claude Code tools are CamelCase (AskUserQuestion, ExitPlanMode). The reducer
// tokenises snake_case names, so normalise before handing them over.
export function normalizeToolName(name) {
  return String(name || 'tool')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase()
}

function sessionOf(payload) {
  const base = String(payload.session_id || 'claude-session')
  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : undefined
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
  return {
    cwd,
    header: {
      id: agentId ? `${base}:${agentId}` : base,
      cwd,
      ...(agentId ? { origin: 'subagent', delegationDepth: 1 } : {}),
    },
  }
}

// A permission prompt carries no tool call id, so every session shares one
// approval id. The reducer ignores a decision it is not waiting for.
function approvalIdOf(session) {
  return `permission:${session.header.id}`
}

/**
 * @param {Record<string, unknown>} payload Claude Code hook stdin payload.
 * @param {number} [seq] Monotonic sequence used to vary status copy.
 * @returns {Array<{ type: 'event', session: object, event: object } | { type: 'dispose', session: object }>}
 */
export function translateClaudeHook(payload, seq = Date.now()) {
  if (!payload || typeof payload !== 'object') return []
  const session = sessionOf(payload)
  const event = (type, data = {}) => ({ type: 'event', session, event: { type, seq, data } })
  const decided = () => event('approval/decided', { id: approvalIdOf(session) })
  const callId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const name = normalizeToolName(payload.tool_name)

  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return [event('turn/start')]

    case 'PreToolUse': {
      const out = [decided(), event('tool/call', { name, callId })]
      const todos = payload.tool_input?.todos
      if (payload.tool_name === 'TodoWrite' && Array.isArray(todos)) out.push(event('todo/write', { todos }))
      return out
    }

    case 'PermissionRequest':
      return [event('approval/asked', { id: approvalIdOf(session), toolName: name })]

    case 'Notification':
      if (payload.notification_type !== 'permission_prompt') return []
      return [event('approval/asked', { id: approvalIdOf(session), toolName: 'permission' })]

    case 'PostToolUse':
      return [decided(), event('tool/result', { callId })]

    case 'PostToolUseFailure':
      return [decided(), event('tool/result', { callId, error: { code: 'tool-failed' } })]

    case 'Stop':
    case 'SubagentStop':
      return [decided(), event('turn/end', { reason: { kind: 'completed' } })]

    case 'StopFailure':
      return [decided(), event('turn/end', { reason: { kind: 'error' } })]

    case 'SessionEnd':
      return [{ type: 'dispose', session }]

    default:
      return []
  }
}

// Fields the daemon needs. The hook script strips everything else before it
// leaves the Claude Code process, so prompts and file contents never travel.
export function slimClaudeHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  const pick = (key) => (typeof payload[key] === 'string' ? payload[key].slice(0, 512) : undefined)
  const slim = {
    hook_event_name: pick('hook_event_name'),
    session_id: pick('session_id'),
    agent_id: pick('agent_id'),
    cwd: pick('cwd'),
    tool_name: pick('tool_name'),
    tool_use_id: pick('tool_use_id'),
    notification_type: pick('notification_type'),
  }
  const todos = payload.tool_name === 'TodoWrite' ? payload.tool_input?.todos : undefined
  if (Array.isArray(todos)) {
    slim.tool_input = {
      todos: todos.slice(0, 50).map((todo) => ({
        content: String(todo?.activeForm || todo?.content || '').slice(0, 120),
        status: String(todo?.status || ''),
      })),
    }
  }
  return slim
}
