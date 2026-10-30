import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanionReducer } from '../../src/core/companion-reducer.js'
import codex, { CODEX_HOOK_EVENTS, codexHooksPath } from '../../src/providers/codex/index.js'

const base = { session_id: 'c1', cwd: '/work/api', model: 'gpt-5' }
const types = (items) => items.map((item) => item.event?.type ?? item.type)

function run(reducer, payloads) {
  const messages = []
  for (const payload of payloads) {
    for (const item of codex.translate(codex.slim({ ...base, ...payload }), 1)) {
      messages.push(...(item.type === 'dispose' ? reducer.disposeSession(item.session) : reducer.handle(item.session, item.event)))
    }
  }
  return messages
}
const lastState = (messages) => messages.filter((message) => message.kind === 'state').at(-1)

test('Codex hooks live in ~/.codex/hooks.json unless CODEX_HOME moves them', () => {
  assert.match(codexHooksPath({}), /\.codex[\\/]hooks\.json$/u)
  assert.equal(codexHooksPath({ CODEX_HOME: '/x/codex' }), join('/x/codex', 'hooks.json'))
})

test('Codex events map onto the shared lifecycle, Interrupt stops the turn', () => {
  assert.deepEqual(types(codex.translate({ ...base, hook_event_name: 'UserPromptSubmit' })), ['turn/start'])
  assert.deepEqual(types(codex.translate({ ...base, hook_event_name: 'PreToolUse', tool_name: 'shell', tool_use_id: 't' })), ['approval/decided', 'tool/call'])
  assert.deepEqual(types(codex.translate({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'shell' })), ['approval/asked'])
  assert.deepEqual(types(codex.translate({ ...base, hook_event_name: 'SessionEnd' })), ['dispose'])
  const [, end] = codex.translate({ ...base, hook_event_name: 'Interrupt' })
  assert.deepEqual(end.event.data.reason, { kind: 'aborted' })
})

test('a Codex turn goes thinking -> working -> waiting -> success', () => {
  const reducer = new CompanionReducer({ hostLabel: 'Codex' })
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'UserPromptSubmit', prompt: 'secret' }])).state, 'THINKING')
  const working = lastState(run(reducer, [{ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 't1' }]))
  assert.equal(working.state, 'WORKING')
  assert.equal(working.activity, 'editing')
  assert.equal(working.project, 'api')
  assert.equal(lastState(run(reducer, [{ hook_event_name: 'PermissionRequest', tool_name: 'shell' }])).state, 'WAITING')
  run(reducer, [{ hook_event_name: 'PostToolUse', tool_use_id: 't1' }])
  assert.ok(run(reducer, [{ hook_event_name: 'Stop' }]).some((message) => message.kind === 'pulse' && message.state === 'SUCCESS'))
})

test('the prompt and tool input never leave Codex', () => {
  const slim = codex.slim({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'secret', tool_input: { command: 'rm' } })
  assert.equal(JSON.stringify(slim).includes('secret'), false)
  assert.equal(slim.tool_input, undefined)
})

test('installing writes the official { hooks } shape, keeps foreign entries and caps the timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-codex-'))
  try {
    const path = join(dir, 'hooks.json')
    writeFileSync(path, JSON.stringify({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other.mjs' }] }] }))
    codex.integration.install(path)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(written.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'other.mjs' }] }])
    assert.deepEqual(Object.keys(written.hooks).sort(), [...CODEX_HOOK_EVENTS].sort())
    const entry = written.hooks.SessionEnd[0].hooks[0]
    assert.match(entry.command, /--source codex$/u)
    assert.ok(entry.timeout <= 3, 'SessionEnd and Interrupt hooks may run for at most 3 s')
    assert.match(codex.setupNote, /\/hooks/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
