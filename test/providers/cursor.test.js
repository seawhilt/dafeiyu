import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionReducer } from '../../src/core/companion-reducer.js'
import cursor, { CURSOR_HOOK_EVENTS } from '../../src/providers/cursor/index.js'

const base = { conversation_id: 'k1', generation_id: 'g1', workspace_roots: ['/work/web'], cursor_version: '2.4.0' }
const types = (items) => items.map((item) => item.event?.type ?? item.type)

function run(reducer, payloads) {
  const messages = []
  for (const payload of payloads) {
    for (const item of cursor.translate(cursor.slim({ ...base, ...payload }), 1)) {
      messages.push(...(item.type === 'dispose' ? reducer.disposeSession(item.session) : reducer.handle(item.session, item.event)))
    }
  }
  return messages
}
const lastState = (messages) => messages.filter((message) => message.kind === 'state').at(-1)

test('Cursor never gets a hook whose silence could block the agent', () => {
  for (const event of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']) {
    assert.equal(CURSOR_HOOK_EVENTS.includes(event), false, event)
  }
})

test('stop status maps to completed, aborted or error', () => {
  const reason = (status) => cursor.translate({ ...base, hook_event_name: 'stop', status }).at(-1).event.data.reason.kind
  assert.equal(reason('completed'), 'completed')
  assert.equal(reason('aborted'), 'aborted')
  assert.equal(reason('error'), 'error')
  assert.deepEqual(types(cursor.translate({ ...base, hook_event_name: 'sessionEnd' })), ['dispose'])
  assert.deepEqual(cursor.translate({ ...base, hook_event_name: 'workspaceOpen' }), [])
})

test('a Cursor turn shows the project, the last tool as work, and failures', () => {
  const reducer = new CompanionReducer({ hostLabel: 'Cursor' })
  const thinking = lastState(run(reducer, [{ hook_event_name: 'beforeSubmitPrompt', prompt: 'secret' }]))
  assert.equal(thinking.state, 'THINKING')
  assert.equal(thinking.project, 'web')
  const working = lastState(run(reducer, [{ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 't1', tool_output: 'x' }]))
  assert.equal(working.state, 'WORKING')
  assert.equal(working.activity, 'commanding')
  const failed = run(reducer, [{ hook_event_name: 'postToolUseFailure', tool_name: 'Edit', tool_use_id: 't2', failure_type: 'error' }])
  assert.ok(failed.some((message) => message.kind === 'pulse' && message.state === 'ERROR'))
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'stop', status: 'error' }])).state, 'ERROR')
})

test('a finished question tool does not leave Cursor waiting', () => {
  const reducer = new CompanionReducer()
  run(reducer, [{ hook_event_name: 'beforeSubmitPrompt' }])
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'postToolUse', tool_name: 'AskQuestion', tool_use_id: 'q' }]) ) ?? 'unchanged', 'unchanged')
})

test('the prompt, tool input and output never leave Cursor', () => {
  const slim = cursor.slim({ ...base, hook_event_name: 'postToolUse', prompt: 'p', tool_input: { a: 'secret' }, tool_output: 'secret', user_email: 'me@x' })
  assert.equal(JSON.stringify(slim).includes('secret'), false)
  assert.equal(JSON.stringify(slim).includes('me@x'), false)
})

test('installing writes version 1 with flat command entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-cursor-'))
  try {
    const path = join(dir, 'hooks.json')
    cursor.integration.install(path)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(written.version, 1)
    assert.match(written.hooks.stop[0].command, /--source cursor$/u)
    assert.equal(written.hooks.stop[0].hooks, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
