import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AnimationModel, crossfadeMs } from '../src/animation-model.js'
import { createPetDirector } from '../src/pet-director.js'
import { createMessage } from '../src/protocol.js'

const MANIFEST = JSON.parse(readFileSync(new URL('../assets/pet-manifest.json', import.meta.url), 'utf8'))

function fakeTimers() {
  const pending = []
  return {
    pending,
    timers: {
      setTimeout: (fn, ms) => { const timer = { fn, ms }; pending.push(timer); return timer },
      clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1) },
    },
    fire(predicate = () => true) {
      const index = pending.findIndex(predicate)
      const [timer] = pending.splice(index, 1)
      timer.fn()
    },
  }
}

function setup({ random = () => 0 } = {}) {
  const sent = []
  let clock = 0
  const timers = fakeTimers()
  const director = createPetDirector({
    manifest: MANIFEST, send: (message) => sent.push(message), now: () => clock, random, timers: timers.timers,
  })
  const plays = () => sent.filter((message) => message.kind === 'play').map((message) => message.clip)
  return { director, sent, plays, timers, tick: (ms) => { clock += ms }, at: () => clock }
}

const state = (value, extra = {}) => createMessage('state', { state: value, ...extra })

test('agent states pick their clip, and repeated events do not replay it', () => {
  const { director, plays } = setup()
  director.observe(state('WORKING', { activity: 'searching' }))
  director.observe(state('WORKING', { activity: 'searching' }))
  director.observe(state('WORKING', { activity: 'editing' }))
  assert.deepEqual(plays(), ['working_search', 'write_code'])
})

test('work clips rotate when the helper reports the end of a pass', () => {
  const { director, plays } = setup()
  director.observe(state('THINKING'))
  director.passEnded('thinking')
  director.passEnded('deep_think')
  director.passEnded('tap_desk')
  assert.deepEqual(plays(), ['thinking', 'deep_think', 'tap_desk', 'thinking'])
  director.passEnded('working')
  assert.equal(plays().length, 4, 'a stale report for another clip is ignored')
})

test('a completion pulse plays, then returns to the agent state on its deadline', () => {
  const { director, plays, timers, tick } = setup()
  director.observe(state('WORKING', { activity: 'commanding' }))
  director.observe(createMessage('pulse', { state: 'SUCCESS', ttlMs: 2200, resumeState: 'IDLE' }))
  assert.equal(plays().at(-1), 'success')
  tick(20000)
  timers.fire((timer) => timer.ms > 2000 && timer.ms < 20000)
  assert.equal(plays().at(-1), 'idle')
})

test('clicks cycle reactions with a line, and rapid clicks get annoyed', () => {
  const { director, plays, sent, tick } = setup()
  director.observe(state('IDLE'))
  director.input({ type: 'click', region: 'poke' })
  assert.equal(plays().at(-1), 'poke')
  assert.match(sent.at(-1).message, /戳我干嘛/)
  director.passEnded('poke')
  assert.equal(plays().at(-1), 'idle')
  tick(500)
  director.input({ type: 'click', region: 'poke' })
  tick(500)
  director.input({ type: 'click', region: 'poke' })
  assert.equal(plays().at(-1), 'click_angry')
  assert.match(sent.at(-1).message, /生气/)
})

test('dragging owns the pet and lands with the release clip', () => {
  const { director, plays } = setup()
  director.observe(state('WORKING', { activity: 'editing' }))
  director.input({ type: 'drag-start' })
  director.observe(state('THINKING'))
  assert.equal(plays().at(-1), 'dragging', 'a new state waits until the drag ends')
  director.input({ type: 'drag-end' })
  assert.equal(plays().at(-1), 'dragging_release')
  director.passEnded('dragging_release')
  assert.equal(plays().at(-1), 'thinking')
})

test('idle actions run only while idle and stop under reduced motion', () => {
  const { director, plays, timers } = setup()
  director.observe(state('IDLE'))
  timers.fire()
  assert.equal(plays().at(-1), MANIFEST.idleMicroClips[0])
  director.observe(state('THINKING'))
  assert.equal(timers.pending.length, 0)
  director.observe(createMessage('config', { reducedMotion: true }))
  director.observe(state('IDLE'))
  assert.equal(timers.pending.length, 0)
})

test('chatter plays its clip only when the pet is idle', () => {
  const { director, plays } = setup()
  director.observe(state('IDLE'))
  director.observe(createMessage('say', { message: '午饭', clip: 'lunch' }))
  assert.equal(plays().at(-1), 'lunch')
  director.passEnded('lunch')
  director.observe(state('WORKING', { activity: 'editing' }))
  director.observe(createMessage('say', { message: 'x', clip: 'lunch' }))
  assert.equal(plays().at(-1), 'write_code')
})

test('menu actions play their clip and show the line', () => {
  const { director, plays, sent } = setup()
  director.observe(state('IDLE'))
  director.input({ type: 'action', clip: 'violin', line: '来一曲吧' })
  assert.equal(plays().at(-1), 'violin')
  assert.equal(sent.at(-1).message, '来一曲吧')
})

test('a new character replays the current state with its own clips', () => {
  const { director, plays } = setup()
  director.observe(state('THINKING'))
  director.setManifest({ ...MANIFEST, stateMap: { ...MANIFEST.stateMap, THINKING: 'deep_think' }, loopVariants: {} })
  assert.equal(plays().at(-1), 'deep_think')
})

test('crossfades skip drag clips and repeats', () => {
  assert.equal(crossfadeMs('idle', 'idle'), 0)
  assert.equal(crossfadeMs('idle', 'dragging'), 0)
  assert.equal(crossfadeMs('thinking', 'working'), 100)
  assert.equal(new AnimationModel(MANIFEST).durationMs('success'), 241 * 42)
})
