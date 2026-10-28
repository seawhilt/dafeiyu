import assert from 'node:assert/strict'
import test from 'node:test'
import { createMessage } from '../src/protocol.js'
import { ProviderHub, resolveActiveProvider } from '../src/provider-hub.js'

function createHub(preferred = null) {
  const sent = []
  const hub = new ProviderHub({ send: (message) => sent.push(message), displaySettings: () => ({ scale: 1 }), preferred })
  return { hub, sent, take: () => sent.splice(0) }
}

const state = (value, extra = {}) => createMessage('state', { state: value, message: value, ...extra })

test('resolveActiveProvider keeps a configured preference and falls back in order', () => {
  assert.equal(resolveActiveProvider('deepseek', ['claude', 'deepseek']), 'deepseek')
  assert.equal(resolveActiveProvider('deepseek', ['claude']), 'claude')
  assert.equal(resolveActiveProvider(null, ['deepseek']), 'deepseek')
  assert.equal(resolveActiveProvider('claude', []), null)
})

test('with nothing configured the pet shows a disconnected hint', () => {
  const { hub, take } = createHub()
  hub.replay()
  const out = take()
  assert.equal(out[0].kind, 'config')
  assert.deepEqual(out[0].providers, [])
  assert.equal(out.find((message) => message.kind === 'state').state, 'DISCONNECTED')
})

test('a single configured provider becomes active without a menu choice', () => {
  const { hub, take } = createHub()
  assert.equal(hub.setAvailable(['claude']), true)
  const out = take()
  assert.equal(hub.active, 'claude')
  assert.equal(out[0].provider, 'claude')
  assert.equal(out.find((message) => message.kind === 'state').state, 'IDLE')
})

test('only the active provider reaches the pet', () => {
  const { hub, take } = createHub('claude')
  hub.setAvailable(['claude', 'deepseek'])
  take()
  hub.receive('deepseek', state('WORKING'))
  hub.receive('deepseek', createMessage('pulse', { state: 'SUCCESS' }))
  assert.deepEqual(take(), [])
  hub.receive('claude', state('THINKING'))
  assert.equal(take()[0].state, 'THINKING')
})

test('switching replays the new provider snapshot and clears foreign balance and tasks', () => {
  const { hub, take } = createHub('deepseek')
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('deepseek', createMessage('balance', { status: 'ready', summary: 'API 余额 ¥1.00' }))
  hub.receive('deepseek', createMessage('tasks', { tasks: [{ sessionId: 'a' }, { sessionId: 'b' }] }))
  hub.receive('claude', state('WORKING', { detail: 'my-app' }))
  take()

  assert.equal(hub.select('claude'), true)
  const out = take()
  assert.equal(out[0].kind, 'config')
  assert.equal(out[0].provider, 'claude')
  assert.equal(out.find((message) => message.kind === 'state').state, 'WORKING')
  assert.deepEqual(out.find((message) => message.kind === 'tasks').tasks, [])
  assert.equal(out.find((message) => message.kind === 'balance').status, 'disabled')

  hub.select('deepseek')
  const back = take()
  assert.equal(back.find((message) => message.kind === 'balance').summary, 'API 余额 ¥1.00')
  assert.equal(back.find((message) => message.kind === 'tasks').tasks.length, 2)
})

test('selecting an unconfigured or current provider is rejected or a no-op', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['claude'])
  take()
  assert.equal(hub.select('deepseek'), false)
  assert.equal(hub.select('claude'), true)
  assert.deepEqual(take(), [])
})

test('provider config only contributes how to open that provider', () => {
  const { hub, take } = createHub('deepseek')
  hub.setAvailable(['deepseek'])
  take()
  hub.receive('deepseek', createMessage('config', { scale: 1.4, openUrl: 'dsh://open', openLabel: '打开 DSH 桌面端' }))
  const [config] = take()
  assert.equal(config.scale, 1)
  assert.equal(config.openUrl, 'dsh://open')
  hub.receive('claude', createMessage('hello', {}))
  assert.deepEqual(take(), [])
})

test('losing the active provider falls back and gaining one updates the menu', () => {
  const { hub, take } = createHub('deepseek')
  hub.setAvailable(['claude', 'deepseek'])
  take()
  assert.equal(hub.setAvailable(['claude']), true)
  assert.equal(hub.active, 'claude')
  take()
  assert.equal(hub.setAvailable(['claude', 'deepseek']), true)
  assert.equal(hub.active, 'deepseek', 'the saved preference wins again once it is back')
})

test('resetProvider forgets the provider snapshot', () => {
  const { hub, take } = createHub('deepseek')
  hub.setAvailable(['deepseek'])
  hub.receive('deepseek', state('ERROR'))
  take()
  hub.resetProvider('deepseek')
  assert.equal(take().find((message) => message.kind === 'state').state, 'IDLE')
})
