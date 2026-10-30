import assert from 'node:assert/strict'
import test from 'node:test'
import { createMessage } from '../../src/core/protocol.js'
import { normalizeOrder, ProviderHub } from '../../src/hub/provider-hub.js'

function createHub(order) {
  const sent = []
  const hub = new ProviderHub({ send: (message) => sent.push(message), displaySettings: () => ({ scale: 1 }), order })
  return { hub, sent, take: () => sent.splice(0) }
}

const state = (value, extra = {}) => createMessage('state', { state: value, message: value, ...extra })
const lastOf = (messages, kind) => messages.filter((message) => message.kind === kind).at(-1)

test('normalizeOrder keeps known ids once and appends the missing ones', () => {
  assert.deepEqual(normalizeOrder(['deepseek', 'nope', 'deepseek']), ['deepseek', 'claude'])
  assert.deepEqual(normalizeOrder(undefined), ['claude', 'deepseek'])
})

test('with nothing available the pet shows a disconnected hint', () => {
  const { hub, take } = createHub()
  hub.replay()
  const out = take()
  assert.equal(out[0].kind, 'config')
  assert.equal(lastOf(out, 'state').state, 'DISCONNECTED')
  assert.equal(hub.displayed, null)
})

test('a single available source is displayed and labelled', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['claude'])
  assert.equal(hub.displayed, 'claude')
  assert.equal(lastOf(take(), 'state').detail, 'Claude · 等待下一次任务')
  hub.receive('claude', state('WORKING', { detail: 'my-app' }))
  assert.equal(lastOf(take(), 'state').detail, 'Claude · my-app')
})

test('the source with the most urgent state is displayed, whatever the order', () => {
  const { hub, take } = createHub(['claude', 'deepseek'])
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('claude', state('WORKING', { detail: 'a' }))
  take()
  hub.receive('deepseek', state('WAITING', { detail: 'b' }))
  assert.equal(hub.displayed, 'deepseek')
  assert.equal(lastOf(take(), 'state').detail, 'DeepSeek · b')
  hub.receive('deepseek', state('IDLE'))
  assert.equal(hub.displayed, 'claude')
  assert.equal(lastOf(take(), 'state').state, 'WORKING')
})

test('equal states follow the user order', () => {
  const { hub } = createHub(['deepseek', 'claude'])
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('claude', state('WORKING'))
  hub.receive('deepseek', state('WORKING'))
  assert.equal(hub.displayed, 'deepseek')
  hub.setOrder(['claude', 'deepseek'])
  assert.equal(hub.displayed, 'claude')
})

test('pulses and balance only come from the displayed source', () => {
  const { hub, take } = createHub(['claude', 'deepseek'])
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('claude', state('WORKING'))
  take()
  hub.receive('deepseek', createMessage('pulse', { state: 'SUCCESS' }))
  hub.receive('deepseek', createMessage('balance', { status: 'ready', summary: 'API 余额 ¥1.00' }))
  assert.deepEqual(take().filter((message) => message.kind !== 'tasks'), [])
  hub.receive('claude', createMessage('pulse', { state: 'SUCCESS', detail: 'done' }))
  assert.equal(lastOf(take(), 'pulse').detail, 'Claude · done')
})

test('tasks merge across sources, a lone session standing in for its source', () => {
  const { hub, take } = createHub(['claude', 'deepseek'])
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('claude', state('WORKING', { sessionId: 'c1', project: 'app' }))
  hub.receive('deepseek', createMessage('tasks', { tasks: [
    { sessionId: 'd1', state: 'THINKING' },
    { sessionId: 'd2', state: 'ERROR' },
  ] }))
  const tasks = lastOf(take(), 'tasks').tasks
  assert.deepEqual(tasks.map((task) => [task.source, task.sessionId, task.state]), [
    ['DeepSeek', 'd2', 'ERROR'],
    ['Claude', 'c1', 'WORKING'],
    ['DeepSeek', 'd1', 'THINKING'],
  ])
})

test('a disabled source disappears from the pet', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('deepseek', state('ERROR'))
  take()
  hub.setAvailable(['claude'])
  assert.equal(hub.displayed, 'claude')
  assert.equal(lastOf(take(), 'state').state, 'IDLE')
})

test('dismissErrors idles error snapshots no reducer will clear', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['claude', 'deepseek'])
  hub.receive('deepseek', state('ERROR'))
  take()
  hub.dismissErrors()
  assert.equal(lastOf(take(), 'state').state, 'IDLE')
})

test('source config only contributes how to open that source', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['deepseek'])
  take()
  hub.receive('deepseek', createMessage('config', { scale: 1.4, openUrl: 'dsh://open', openLabel: '打开 DSH 桌面端' }))
  const [config] = take()
  assert.equal(config.scale, 1)
  assert.equal(config.openUrl, 'dsh://open')
  hub.receive('claude', createMessage('hello', {}))
  assert.deepEqual(take(), [])
})

test('resetProvider forgets the source snapshot', () => {
  const { hub, take } = createHub()
  hub.setAvailable(['deepseek'])
  hub.receive('deepseek', state('ERROR'))
  take()
  hub.resetProvider('deepseek')
  assert.equal(lastOf(take(), 'state').state, 'IDLE')
})
