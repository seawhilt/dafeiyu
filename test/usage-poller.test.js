import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsagePoller } from '../src/usage-poller.js'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

test('an after-turn request during an in-flight query wins over the poll interval', async (t) => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const poller = createUsagePoller({
    query: async () => {
      calls += 1
      if (calls === 1) await gate
      return { session: { percent: 1 } }
    },
    enabled: () => true,
    onUsage: () => {},
    timings: { pollMs: 5000, afterTurnMs: 10 },
    logger: { warn() {} },
  })
  t.after(() => poller.stop())

  poller.start()
  await sleep(5)
  assert.equal(calls, 1, 'the initial poll is running')
  poller.afterTurn()
  release()
  await sleep(100)
  assert.equal(calls, 2, 'the finished turn triggers another query instead of waiting for pollMs')
})

test('a turn after the timer was armed replaces the poll delay', async (t) => {
  let calls = 0
  const poller = createUsagePoller({
    query: async () => { calls += 1; return {} },
    enabled: () => true,
    onUsage: () => {},
    timings: { pollMs: 5000, afterTurnMs: 10 },
    logger: { warn() {} },
  })
  t.after(() => poller.stop())

  poller.start()
  await sleep(30)
  assert.equal(calls, 1)
  poller.afterTurn()
  await sleep(60)
  assert.equal(calls, 2)
})

test('stop prevents further queries', async (t) => {
  let calls = 0
  const poller = createUsagePoller({
    query: async () => { calls += 1; return {} },
    enabled: () => true,
    onUsage: () => {},
    timings: { pollMs: 5, afterTurnMs: 5 },
    logger: { warn() {} },
  })
  poller.start()
  await sleep(20)
  poller.stop()
  const settled = calls
  await sleep(40)
  assert.equal(calls, settled)
})
