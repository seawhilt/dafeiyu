import assert from 'node:assert/strict'
import test from 'node:test'
import { createPetWindow } from '../src/pet-window.js'

test('a character switch waits for the previous helper to exit before starting the next', async () => {
  const events = []
  const helpers = []
  let exitPrevious
  const createHelper = () => {
    const helper = {
      started: 0,
      stopped: 0,
      start() { this.started += 1; events.push('start') },
      send() {},
      stop() { this.stopped += 1; events.push('stop') },
      whenExited() { return new Promise((resolve) => { exitPrevious = resolve }) },
    }
    helpers.push(helper)
    return helper
  }
  const window = createPetWindow({
    createHelper,
    environment: () => ({}),
    character: () => 'whale',
    home: '/tmp/dafeiyu-test-home',
    petsRoot: '/tmp/dafeiyu-test-pets',
    onSettingsChange() {},
    onClosed() {},
    logger: { warn() {} },
  })
  assert.equal(helpers.length, 1)

  const restarting = window.restart()
  await Promise.resolve()
  assert.equal(helpers.length, 2, 'the next helper is created immediately')
  assert.equal(helpers[0].stopped, 1, 'the old helper is asked to stop')
  assert.equal(helpers[1].started, 0, 'but the next window waits for it to exit')

  exitPrevious()
  await restarting
  assert.equal(helpers[1].started, 1)
  assert.deepEqual(events, ['stop', 'start'])
})
