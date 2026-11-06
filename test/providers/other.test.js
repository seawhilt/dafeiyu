import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanionReducer } from '../../src/core/companion-reducer.js'
import other, { agentName, eventPayload, otherHookCommand } from '../../src/providers/other/index.js'

const types = (items) => items.map((item) => item.event?.type ?? item.type)
const lastState = (messages) => messages.filter((message) => message.kind === 'state').at(-1)

function run(reducer, payloads, name = 'gemini') {
  const messages = []
  for (const payload of payloads) {
    for (const item of other.translate(other.slim(payload, { name }), 1)) {
      messages.push(...(item.type === 'dispose' ? reducer.disposeSession(item.session) : reducer.handle(item.session, item.event)))
    }
  }
  return messages
}

test('a tool name is a short lowercase slug, anything else falls back to "other"', () => {
  assert.equal(agentName('gemini'), 'gemini')
  assert.equal(agentName('Kimi-CLI'), 'kimi-cli')
  assert.equal(agentName('../etc'), 'other')
  assert.equal(agentName(''), 'other')
  assert.equal(agentName(undefined), 'other')
  assert.equal(agentName('a'.repeat(40)), 'other')
})

test('Claude-style event names pass through, Gemini CLI names and short words map onto them', () => {
  const name = (event) => other.slim({ hook_event_name: event }, { name: 'x' }).hook_event_name
  assert.equal(name('PreToolUse'), 'PreToolUse')
  assert.equal(name('BeforeAgent'), 'UserPromptSubmit')
  assert.equal(name('BeforeTool'), 'PreToolUse')
  assert.equal(name('AfterTool'), 'PostToolUse')
  assert.equal(name('AfterAgent'), 'Stop')
  assert.equal(name('start'), 'UserPromptSubmit')
  assert.equal(name('tool'), 'PreToolUse')
  assert.equal(name('done'), 'Stop')
  assert.equal(name('error'), 'StopFailure')
  assert.equal(name('end'), 'SessionEnd')
  assert.equal(other.slim({ hook_event_name: 'TranscriptWrite' }, { name: 'x' }), undefined)
})

test('each tool keeps its own sessions, even when two tools reuse a session id', () => {
  const [gemini] = other.translate(other.slim({ hook_event_name: 'BeforeAgent', session_id: 's' }, { name: 'gemini' }))
  const [kimi] = other.translate(other.slim({ hook_event_name: 'BeforeAgent', session_id: 's' }, { name: 'kimi' }))
  assert.equal(gemini.session.header.id, 'gemini:s')
  assert.equal(kimi.session.header.id, 'kimi:s')
  const [unnamed] = other.translate(other.slim({ hook_event_name: 'start' }, { name: 'qoder' }))
  assert.equal(unnamed.session.header.id, 'qoder:default')
})

test('a Gemini CLI turn goes thinking -> working -> success', () => {
  const reducer = new CompanionReducer({ hostLabel: '其他工具' })
  const base = { session_id: 'g1', cwd: '/work/shop' }
  assert.equal(lastState(run(reducer, [{ ...base, hook_event_name: 'BeforeAgent', prompt: 'secret' }])).state, 'THINKING')
  const working = lastState(run(reducer, [{ ...base, hook_event_name: 'BeforeTool', tool_name: 'write_file' }]))
  assert.equal(working.state, 'WORKING')
  assert.equal(working.project, 'shop')
  run(reducer, [{ ...base, hook_event_name: 'AfterTool' }])
  assert.ok(run(reducer, [{ ...base, hook_event_name: 'AfterAgent' }]).some((message) => message.kind === 'pulse' && message.state === 'SUCCESS'))
})

test('the prompt, tool input and reply never leave the tool', () => {
  const slim = other.slim({
    hook_event_name: 'BeforeTool',
    prompt: 'secret',
    tool_input: { command: 'secret' },
    prompt_response: 'secret',
  }, { name: 'gemini' })
  assert.equal(JSON.stringify(slim).includes('secret'), false)
})

test('a command-line event becomes a payload without reading stdin', () => {
  assert.deepEqual(eventPayload('working', { cwd: '/work/api', sessionId: 'abc' }), {
    hook_event_name: 'working',
    session_id: 'abc',
    cwd: '/work/api',
  })
  assert.equal(eventPayload('', { cwd: '/x' }), undefined)
  assert.equal(other.slim(eventPayload('working', { cwd: '/x' }), { name: 'x' }).hook_event_name, 'PreToolUse')
})

test('the setup command names the tool after --source other', () => {
  assert.match(otherHookCommand('gemini'), /dafeiyu-hook\.mjs" --source other --name gemini$/u)
  assert.match(otherHookCommand('Bad Name!'), /--name other$/u)
})

test('there is nothing to install: the user adds the command to their tool', () => {
  assert.equal(other.integration, undefined)
  assert.ok(other.setupNote)
})
