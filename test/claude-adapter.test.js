import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeToolName, slimClaudeHookPayload, translateClaudeHook } from '../src/claude-adapter.js'
import { CompanionReducer } from '../src/companion-reducer.js'

const base = { session_id: 's1', cwd: '/work/my-app' }
const types = (items) => items.map((item) => item.event?.type ?? item.type)

function run(reducer, payloads) {
  const messages = []
  for (const payload of payloads) {
    for (const item of translateClaudeHook({ ...base, ...payload }, 1)) {
      messages.push(...(item.type === 'dispose'
        ? reducer.disposeSession(item.session)
        : reducer.handle(item.session, item.event)))
    }
  }
  return messages
}

const lastState = (messages) => messages.filter((message) => message.kind === 'state').at(-1)

test('normalizes CamelCase tool names so question tools are recognised', () => {
  assert.equal(normalizeToolName('AskUserQuestion'), 'ask_user_question')
  assert.equal(normalizeToolName('ExitPlanMode'), 'exit_plan_mode')
  assert.equal(normalizeToolName('WebFetch'), 'web_fetch')
  assert.equal(normalizeToolName('mcp__github__create_issue'), 'mcp__github__create_issue')
  assert.equal(normalizeToolName(undefined), 'tool')
})

test('maps the Claude Code hook lifecycle to reducer events', () => {
  assert.deepEqual(types(translateClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit' })), ['turn/start'])
  assert.deepEqual(types(translateClaudeHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' })), ['approval/decided', 'tool/call'])
  assert.deepEqual(types(translateClaudeHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 't1' })), ['approval/decided', 'tool/result'])
  assert.deepEqual(types(translateClaudeHook({ ...base, hook_event_name: 'Stop' })), ['approval/decided', 'turn/end'])
  assert.deepEqual(types(translateClaudeHook({ ...base, hook_event_name: 'SessionEnd' })), ['dispose'])
  assert.deepEqual(translateClaudeHook({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' }), [])
  assert.deepEqual(translateClaudeHook({ ...base, hook_event_name: 'SomethingNew' }), [])
  assert.deepEqual(translateClaudeHook(null), [])
})

test('a full turn goes thinking -> working -> success pulse', () => {
  const reducer = new CompanionReducer({ hostLabel: 'Claude' })
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'UserPromptSubmit' }])).state, 'THINKING')
  const working = lastState(run(reducer, [{ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't1' }]))
  assert.equal(working.state, 'WORKING')
  assert.equal(working.activity, 'editing')
  assert.equal(working.project, 'my-app')
  run(reducer, [{ hook_event_name: 'PostToolUse', tool_use_id: 't1' }])
  const end = run(reducer, [{ hook_event_name: 'Stop' }])
  assert.ok(end.some((message) => message.kind === 'pulse' && message.state === 'SUCCESS'))
})

test('a permission prompt waits until the tool continues', () => {
  const reducer = new CompanionReducer()
  run(reducer, [{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' }])
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'Notification', notification_type: 'permission_prompt' }])).state, 'WAITING')
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'PostToolUse', tool_use_id: 't1' }])).state, 'THINKING')
})

test('AskUserQuestion shows as waiting for the user', () => {
  const reducer = new CompanionReducer()
  const messages = run(reducer, [{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1' }])
  assert.equal(lastState(messages).state, 'WAITING')
})

test('a failed tool produces an error pulse and StopFailure ends in error', () => {
  const reducer = new CompanionReducer()
  run(reducer, [{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' }])
  const failed = run(reducer, [{ hook_event_name: 'PostToolUseFailure', tool_use_id: 't1' }])
  assert.ok(failed.some((message) => message.kind === 'pulse' && message.state === 'ERROR'))
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'StopFailure' }])).state, 'ERROR')
})

test('TodoWrite updates the task progress', () => {
  const reducer = new CompanionReducer()
  run(reducer, [{ hook_event_name: 'UserPromptSubmit' }])
  const messages = run(reducer, [{
    hook_event_name: 'PreToolUse',
    tool_name: 'TodoWrite',
    tool_use_id: 'todo',
    tool_input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
  }])
  const progress = messages.findLast((message) => message.progress)?.progress
  assert.deepEqual(progress, { completed: 1, total: 2, current: 2 })
})

test('subagent events are ignored unless subagents are enabled', () => {
  const reducer = new CompanionReducer()
  assert.deepEqual(run(reducer, [{ hook_event_name: 'UserPromptSubmit', agent_id: 'sub' }]), [])
})

test('slimming keeps only routing fields and short todo text', () => {
  const slim = slimClaudeHookPayload({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'TodoWrite',
    prompt: 'secret prompt',
    transcript_path: '/tmp/t.jsonl',
    tool_input: { todos: [{ content: 'x'.repeat(500), activeForm: 'Doing x', status: 'pending', extra: 1 }] },
  })
  assert.equal(slim.prompt, undefined)
  assert.equal(slim.transcript_path, undefined)
  assert.deepEqual(slim.tool_input, { todos: [{ content: 'Doing x', status: 'pending' }] })
  const bash = slimClaudeHookPayload({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })
  assert.equal(bash.tool_input, undefined)
  assert.equal(slimClaudeHookPayload('nope'), undefined)
})
