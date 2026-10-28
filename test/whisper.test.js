import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMessage } from '../src/protocol.js'
import {
  clipFor,
  crossedQuotaAlerts,
  holidayOf,
  loadWhisperLines,
  pickWhisper,
  quotaAlertText,
  whisperCategories,
  WhisperScheduler,
} from '../src/whisper.js'
import { WHISPER_LINES } from '../src/whisper-lines.js'

const at = (iso) => new Date(iso)
const base = { provider: 'claude', idleMs: 0, successesToday: 0 }

test('categories follow the time of day and weekends', () => {
  assert.ok(whisperCategories({ ...base, now: at('2026-10-27T08:00:00') }).includes('morning'))
  assert.ok(whisperCategories({ ...base, now: at('2026-10-27T12:00:00') }).includes('noon'))
  assert.ok(whisperCategories({ ...base, now: at('2026-10-27T18:00:00') }).includes('evening'))
  assert.ok(whisperCategories({ ...base, now: at('2026-10-27T02:00:00') }).includes('lateNight'))
  assert.ok(whisperCategories({ ...base, now: at('2026-10-31T15:00:00') }).includes('weekend'))
  assert.deepEqual(whisperCategories({ ...base, provider: null, now: at('2026-10-27T15:00:00') }), ['autumn'])
})

test('categories follow recent work and quota', () => {
  const now = at('2026-10-27T15:00:00')
  const categories = whisperCategories({
    ...base,
    now,
    idleMs: 40 * 60000,
    lastSuccessAgoMs: 60000,
    lastErrorAgoMs: 60000,
    successesToday: 6,
    usage: { session: { percent: 75 } },
  })
  for (const name of ['afterError', 'justFinished', 'streak', 'longIdle', 'quotaHigh', 'claude']) {
    assert.ok(categories.includes(name), name)
  }
  assert.ok(!whisperCategories({ ...base, now, provider: 'deepseek', usage: { session: { percent: 99 } } }).includes('quotaHigh'))
})

test('picking prefers fitting lines and skips recent ones', () => {
  const lines = { morning: ['a', 'b'], generic: ['g'], christmas: ['x'] }
  assert.deepEqual(pickWhisper(['morning'], lines, ['a'], () => 0), { line: 'b', category: 'morning' })
  assert.equal(pickWhisper(['morning'], lines, [], () => 0.9).line, 'g')
  assert.equal(pickWhisper([], lines, [], () => 0).line, 'g')
  assert.equal(pickWhisper(['morning'], lines, ['a', 'b'], () => 0).line, 'a', 'falls back to repeats when all were said')
  assert.equal(pickWhisper(['missing'], {}, [], () => 0), undefined)
  assert.deepEqual(pickWhisper(['christmas', 'morning'], lines, [], () => 0.1), { line: 'x', category: 'christmas' })
})

test('holidays follow the Gregorian and lunar calendars', () => {
  const on = (iso) => holidayOf(at(`${iso}T12:00:00`))
  assert.equal(on('2026-02-16'), 'newYearsEve')
  assert.equal(on('2026-02-17'), 'springFestival')
  assert.equal(on('2026-03-03'), 'lantern')
  assert.equal(on('2026-04-05'), 'qingming')
  assert.equal(on('2026-06-19'), 'dragonBoat')
  assert.equal(on('2026-08-19'), 'qixi')
  assert.equal(on('2026-09-25'), 'midAutumn')
  assert.equal(on('2026-10-18'), 'doubleNinth')
  assert.equal(on('2026-10-31'), 'halloween')
  assert.equal(on('2026-12-25'), 'christmas')
  assert.equal(on('2027-01-01'), 'newYear')
  assert.equal(on('2027-01-15'), 'laba')
  assert.equal(on('2026-10-27'), undefined)
  assert.ok(whisperCategories({ ...base, now: at('2026-02-17T15:00:00') }).includes('springFestival'))
  assert.ok(whisperCategories({ ...base, now: at('2026-07-10T15:00:00') }).includes('summer'))
})

test('lines come with a fitting animation', () => {
  assert.equal(clipFor('noon', () => 0), 'lunch')
  assert.equal(clipFor('dragonBoat', () => 0), 'zongzi')
  assert.match(clipFor('generic', () => 0), /^say_/)
})

test('user lines extend or replace built-in categories', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-whisper-'))
  try {
    assert.equal(loadWhisperLines(home), WHISPER_LINES)
    writeFileSync(join(home, 'whispers.json'), JSON.stringify({ lines: { generic: ['  我的台词  ', 3, ''], unknown: ['x'] } }))
    const extended = loadWhisperLines(home)
    assert.equal(extended.generic.at(-1), '我的台词')
    assert.equal(extended.generic.length, WHISPER_LINES.generic.length + 1)
    assert.equal(extended.unknown, undefined)
    writeFileSync(join(home, 'whispers.json'), JSON.stringify({ replace: true, lines: { generic: ['只说这句'] } }))
    assert.deepEqual(loadWhisperLines(home).generic, ['只说这句'])
    assert.deepEqual(loadWhisperLines(home).morning, WHISPER_LINES.morning)
    writeFileSync(join(home, 'whispers.json'), '{ broken')
    assert.equal(loadWhisperLines(home), WHISPER_LINES)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('quota alerts fire once per crossed step and re-arm after a reset', () => {
  assert.deepEqual(crossedQuotaAlerts({ session: { percent: 70 } }, { session: { percent: 82 } }), ['session80'])
  assert.deepEqual(crossedQuotaAlerts({ session: { percent: 82 } }, { session: { percent: 85 } }), [])
  assert.deepEqual(crossedQuotaAlerts({ session: { percent: 82 } }, { session: { percent: 96 } }), ['session95'])
  assert.deepEqual(crossedQuotaAlerts({ session: { percent: 97 } }, { session: { percent: 96 } }), [])
  assert.deepEqual(crossedQuotaAlerts({ session: { percent: 97 } }, { session: { percent: 3 } }), [])
  assert.deepEqual(crossedQuotaAlerts(undefined, { weekly: { percent: 81 } }), ['weekly80'])
  assert.match(quotaAlertText('weekly95', { weekly: { percent: 96.4 } }), /96%/)
})

function fakeTimers() {
  const pending = []
  return {
    pending,
    timers: {
      setTimeout: (fn, ms) => { const timer = { fn, ms }; pending.push(timer); return timer },
      clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1) },
    },
    fire() { pending.shift().fn() },
  }
}

test('the scheduler speaks only while idle and backs off while busy', () => {
  const said = []
  const clock = fakeTimers()
  const scheduler = new WhisperScheduler({
    level: 'high',
    lines: { generic: ['hello'] },
    say: (message) => said.push(message),
    random: () => 0,
    now: () => at('2026-10-27T15:00:00'),
    timers: clock.timers,
  })
  scheduler.start()
  assert.equal(clock.pending[0].ms, 5 * 60000)
  scheduler.observe(createMessage('state', { state: 'WORKING' }))
  clock.fire()
  assert.equal(said.length, 0)
  assert.equal(clock.pending[0].ms, 2 * 60000, 'busy pets retry sooner')
  scheduler.observe(createMessage('state', { state: 'IDLE' }))
  clock.fire()
  assert.equal(said[0].kind, 'say')
  assert.equal(said[0].message, 'hello')
  assert.equal(said[0].urgent, false)
  assert.match(said[0].clip, /^say_/)

  scheduler.setLevel('off')
  assert.equal(clock.pending.length, 0)
  assert.equal(scheduler.speak(), 'hello', 'manual requests work even when the timer is off')
  scheduler.stop()
})

test('successes and errors feed the context', () => {
  const said = []
  let now = at('2026-10-27T15:00:00')
  const scheduler = new WhisperScheduler({
    lines: { justFinished: ['done'], afterError: ['oops'], generic: [] },
    say: (message) => said.push(message.message),
    random: () => 0,
    now: () => now,
    timers: fakeTimers().timers,
  })
  scheduler.observe(createMessage('pulse', { state: 'SUCCESS' }))
  assert.equal(scheduler.speak(), 'done')
  now = at('2026-10-27T16:00:00')
  scheduler.observe(createMessage('pulse', { state: 'ERROR' }))
  assert.equal(scheduler.speak(), 'oops')
})

test('quota alerts are urgent', () => {
  const said = []
  const scheduler = new WhisperScheduler({ say: (message) => said.push(message), timers: fakeTimers().timers })
  scheduler.alertQuota({ session: { percent: 90 } }, { session: { percent: 96 } })
  assert.equal(said.length, 1)
  assert.equal(said[0].urgent, true)
  assert.equal(said[0].clip, 'money_empty', 'the 95% step shows an empty purse')
  assert.match(said[0].message, /96%/)
})
