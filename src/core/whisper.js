import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CompanionMessageKind, CompanionState, createMessage } from './protocol.js'
import { QUOTA_ALERT_LINES, WHISPER_LINES } from './whisper-lines.js'

const MINUTE = 60 * 1000
export const WHISPER_LEVELS = Object.freeze({
  off: null,
  low: Object.freeze([15 * MINUTE, 30 * MINUTE]),
  high: Object.freeze([5 * MINUTE, 10 * MINUTE]),
})
export const WHISPER_LEVEL_IDS = Object.freeze(Object.keys(WHISPER_LEVELS))
const SAY_TTL_MS = 6000
const ALERT_TTL_MS = 8000
const RECENT_LIMIT = 8
const BUSY_RETRY_MS = 2 * MINUTE
const JUST_FINISHED_MS = 3 * MINUTE
const LONG_IDLE_MS = 30 * MINUTE
const STREAK_COUNT = 5
const AFTER_ERROR_MS = 10 * MINUTE
const QUOTA_HIGH_PERCENT = 70
const QUOTA_ALERT_STEPS = Object.freeze([95, 80])
// Specific situations win most of the time; generic lines keep variety.
const CONTEXT_WEIGHT = 0.7

// Animations that fit each category; others use a generic talking clip.
// The pet ignores names its manifest does not have.
export const CATEGORY_CLIPS = Object.freeze({
  morning: ['breakfast', 'brush_teeth'],
  noon: ['lunch', 'what_to_eat', 'rice'],
  evening: ['dinner', 'hotpot', 'what_to_eat'],
  lateNight: ['doze', 'nap'],
  longIdle: ['nap', 'doze', 'look_around', 'tap_desk'],
  justFinished: ['idle_stretch', 'hum', 'sway_dance'],
  streak: ['click_happy', 'success', 'maid_dance', 'otaku_dance'],
  afterError: ['say_wipe', 'game_rage'],
  quotaHigh: ['money_worry', 'money_ok'],
  summer: ['watermelon', 'fan', 'ice_cream', 'water_gun'],
  autumn: ['crab', 'leaves', 'kite'],
  winter: ['snowman', 'tanghulu'],
  springFestival: ['red_packet', 'dumplings', 'write_fu', 'lion_dance', 'fireworks', 'niangao'],
  newYearsEve: ['fireworks', 'write_fu', 'dumplings'],
  lantern: ['tangyuan', 'sky_lantern'],
  qingming: ['qingtuan', 'kite'],
  dragonBoat: ['zongzi'],
  qixi: ['qixi'],
  midAutumn: ['mooncake'],
  doubleNinth: ['chongyang', 'chrysanthemum'],
  laba: ['laba'],
  halloween: ['pumpkin', 'ghost'],
  christmas: ['xmas_tree', 'gift', 'snowman'],
  newYear: ['fireworks', 'gift'],
})
export const SAY_CLIPS = Object.freeze(['say_daze', 'say_screen', 'say_wipe', 'deep_think'])
// Quota alerts show a worried purse, or an empty one near the limit.
const QUOTA_ALERT_CLIPS = Object.freeze({ 80: 'money_worry', 95: 'money_empty' })
// On a holiday its lines win half of the time, so the day is noticeable.
const HOLIDAY_WEIGHT = 0.5

const lunarFormat = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' })

function lunarDate(date) {
  const parts = Object.fromEntries(lunarFormat.formatToParts(date).map((part) => [part.type, part.value]))
  return { month: parts.month, day: Number(parts.day) }
}

/** The holiday category for a date, or undefined. Lunar dates use Intl's Chinese calendar. */
export function holidayOf(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const lunar = lunarDate(date)
  const tomorrow = lunarDate(new Date(date.getTime() + 24 * 60 * 60 * 1000))
  if (tomorrow.month === '1' && tomorrow.day === 1) return 'newYearsEve'
  if (lunar.month === '1' && lunar.day <= 7) return 'springFestival'
  if (lunar.month === '1' && lunar.day === 15) return 'lantern'
  if (lunar.month === '5' && lunar.day === 5) return 'dragonBoat'
  if (lunar.month === '7' && lunar.day === 7) return 'qixi'
  if (lunar.month === '8' && lunar.day === 15) return 'midAutumn'
  if (lunar.month === '9' && lunar.day === 9) return 'doubleNinth'
  if (lunar.month === '12' && lunar.day === 8) return 'laba'
  if (month === 1 && day === 1) return 'newYear'
  if (month === 4 && day >= 4 && day <= 6) return 'qingming'
  if (month === 10 && day === 31) return 'halloween'
  if (month === 12 && (day === 24 || day === 25)) return 'christmas'
  return undefined
}

function seasonOf(date) {
  const month = date.getMonth() + 1
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  if (month === 12 || month <= 2) return 'winter'
  return undefined
}

const HOLIDAY_CATEGORIES = new Set([
  'springFestival', 'newYearsEve', 'lantern', 'qingming', 'dragonBoat', 'qixi', 'midAutumn',
  'doubleNinth', 'laba', 'halloween', 'christmas', 'newYear',
])

const MAX_LINE_LENGTH = 60
const MAX_LINES_PER_CATEGORY = 200

/**
 * Merge user lines from whispers.json: { "replace": false, "lines": { category: [..] } }.
 * Unknown categories are ignored; invalid files fall back to the built-ins.
 */
export function loadWhisperLines(home, { read = readFileSync } = {}) {
  let custom
  try {
    custom = JSON.parse(read(join(home, 'whispers.json'), 'utf8'))
  } catch {
    return WHISPER_LINES
  }
  const lines = custom?.lines
  if (!lines || typeof lines !== 'object') return WHISPER_LINES
  const merged = {}
  for (const [category, builtIn] of Object.entries(WHISPER_LINES)) {
    const extra = Array.isArray(lines[category])
      ? lines[category].filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim().slice(0, MAX_LINE_LENGTH))
      : []
    const base = custom.replace === true && extra.length > 0 ? [] : builtIn
    merged[category] = [...base, ...extra].slice(0, MAX_LINES_PER_CATEGORY)
  }
  return merged
}

/** Categories that fit the moment, most specific first. */
export function whisperCategories({ now, provider, idleMs, lastSuccessAgoMs, lastErrorAgoMs, successesToday, usage }) {
  const hour = now.getHours() + now.getMinutes() / 60
  const day = now.getDay()
  const categories = []
  const holiday = holidayOf(now)
  if (holiday) categories.push(holiday)
  if (lastErrorAgoMs !== undefined && lastErrorAgoMs < AFTER_ERROR_MS) categories.push('afterError')
  if (lastSuccessAgoMs !== undefined && lastSuccessAgoMs < JUST_FINISHED_MS) categories.push('justFinished')
  if (successesToday >= STREAK_COUNT) categories.push('streak')
  if (idleMs >= LONG_IDLE_MS) categories.push('longIdle')
  if (hour >= 23 || hour < 5) categories.push('lateNight')
  else if (hour >= 6 && hour < 10) categories.push('morning')
  else if (hour >= 11.5 && hour < 13.5) categories.push('noon')
  else if (hour >= 17.5 && hour < 19.5) categories.push('evening')
  if (day === 0 || day === 6) categories.push('weekend')
  const season = seasonOf(now)
  if (season) categories.push(season)
  const quota = Math.max(usage?.session?.percent ?? 0, usage?.weekly?.percent ?? 0)
  if (provider === 'claude' && quota >= QUOTA_HIGH_PERCENT) categories.push('quotaHigh')
  if (provider === 'claude' || provider === 'deepseek') categories.push(provider)
  return categories
}

/**
 * Pick one line, avoiding recently said ones when possible.
 * @returns {{ line: string, category: string } | undefined}
 */
export function pickWhisper(categories, lines, recent = [], random = Math.random) {
  const pool = (names) => names.flatMap((name) => (lines[name] ?? []).map((line) => ({ line, category: name })))
  const fresh = (candidates) => {
    const unseen = candidates.filter((entry) => !recent.includes(entry.line))
    return unseen.length > 0 ? unseen : candidates
  }
  const holiday = categories.find((name) => HOLIDAY_CATEGORIES.has(name))
  const festive = holiday ? fresh(pool([holiday])) : []
  const specific = fresh(pool(categories))
  const generic = fresh(pool(['generic']))
  let candidates
  if (festive.length > 0 && random() < HOLIDAY_WEIGHT) candidates = festive
  else if (specific.length > 0 && (generic.length === 0 || random() < CONTEXT_WEIGHT)) candidates = specific
  else candidates = generic
  if (candidates.length === 0) return undefined
  return candidates[Math.floor(random() * candidates.length) % candidates.length]
}

/** An animation that fits the line's category, or a generic talking one. */
export function clipFor(category, random = Math.random) {
  const options = CATEGORY_CLIPS[category] ?? SAY_CLIPS
  return options[Math.floor(random() * options.length) % options.length]
}

/**
 * Thresholds newly crossed since the previous usage report.
 * @returns {string[]} alert keys such as "session95"
 */
export function crossedQuotaAlerts(previous, next) {
  const alerts = []
  for (const window of ['session', 'weekly']) {
    const before = previous?.[window]?.percent ?? 0
    const after = next?.[window]?.percent
    if (after === undefined) continue
    // Only the highest newly crossed step speaks; a reset back below a step
    // re-arms it because `before` drops with it.
    const step = QUOTA_ALERT_STEPS.find((value) => after >= value)
    if (step !== undefined && before < step) alerts.push(`${window}${step}`)
  }
  return alerts
}

export function quotaAlertText(key, usage) {
  const window = key.startsWith('session') ? 'session' : 'weekly'
  const percent = `${Math.round(usage?.[window]?.percent ?? 0)}%`
  return (QUOTA_ALERT_LINES[key] ?? '').replace('{percent}', percent)
}

export function sayMessage(text, { urgent = false, clip } = {}) {
  return createMessage(CompanionMessageKind.SAY, {
    message: text,
    ttlMs: urgent ? ALERT_TTL_MS : SAY_TTL_MS,
    urgent,
    ...(clip ? { clip } : {}),
  })
}

/**
 * Observes what the pet shows and says something on a randomised timer while
 * the active provider is idle. Never calls a model.
 */
export class WhisperScheduler {
  constructor({
    level = 'low',
    lines = WHISPER_LINES,
    say,
    activeProvider = () => null,
    usage = () => undefined,
    random = Math.random,
    now = () => new Date(),
    timers = { setTimeout, clearTimeout },
  }) {
    this.level = WHISPER_LEVELS[level] === undefined ? 'low' : level
    this.lines = lines
    this.say = say
    this.activeProvider = activeProvider
    this.usage = usage
    this.random = random
    this.now = now
    this.timers = timers
    this.recent = []
    this.state = CompanionState.IDLE
    this.idleSince = now().getTime()
    this.lastSuccessAt = undefined
    this.lastErrorAt = undefined
    this.successDay = ''
    this.successesToday = 0
    this.timer = undefined
    this.stopped = false
  }

  start() {
    this.stopped = false
    this.#schedule()
  }

  stop() {
    this.stopped = true
    this.#clear()
  }

  setLevel(level) {
    if (WHISPER_LEVELS[level] === undefined || level === this.level) return
    this.level = level
    this.#schedule()
  }

  /** Feed every message sent to the pet so idle time and outcomes stay current. */
  observe(message) {
    const at = this.now().getTime()
    if (message.kind === CompanionMessageKind.STATE) {
      const next = message.state
      if (next === CompanionState.IDLE && this.state !== CompanionState.IDLE) this.idleSince = at
      if (next === CompanionState.ERROR) this.lastErrorAt = at
      this.state = next
    }
    if (message.kind === CompanionMessageKind.PULSE) {
      if (message.state === CompanionState.SUCCESS) this.#countSuccess(at)
      if (message.state === CompanionState.ERROR) this.lastErrorAt = at
    }
  }

  /** Say one line now (right-click "说句话"); returns the line or undefined. */
  speak() {
    const now = this.now()
    const at = now.getTime()
    const categories = whisperCategories({
      now,
      provider: this.activeProvider(),
      idleMs: this.state === CompanionState.IDLE ? at - this.idleSince : 0,
      lastSuccessAgoMs: this.lastSuccessAt === undefined ? undefined : at - this.lastSuccessAt,
      lastErrorAgoMs: this.lastErrorAt === undefined ? undefined : at - this.lastErrorAt,
      successesToday: this.#todayCount(now),
      usage: this.usage(),
    })
    const picked = pickWhisper(categories, this.lines, this.recent, this.random)
    if (!picked) return undefined
    this.recent = [picked.line, ...this.recent].slice(0, RECENT_LIMIT)
    this.say(sayMessage(picked.line, { clip: clipFor(picked.category, this.random) }))
    return picked.line
  }

  /** Urgent quota alerts bypass the idle check and the timer. */
  alertQuota(previous, next) {
    for (const key of crossedQuotaAlerts(previous, next)) {
      this.say(sayMessage(quotaAlertText(key, next), { urgent: true, clip: QUOTA_ALERT_CLIPS[key.replace(/\D/gu, '')] }))
    }
  }

  #countSuccess(at) {
    this.lastSuccessAt = at
    this.#todayCount(new Date(at))
    this.successesToday += 1
  }

  #todayCount(date) {
    const day = date.toDateString()
    if (day !== this.successDay) {
      this.successDay = day
      this.successesToday = 0
    }
    return this.successesToday
  }

  #clear() {
    if (this.timer) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  #schedule(delay) {
    this.#clear()
    const range = WHISPER_LEVELS[this.level]
    if (this.stopped || !range) return
    const [low, high] = range
    const wait = delay ?? low + Math.floor(this.random() * (high - low))
    this.timer = this.timers.setTimeout(() => this.#tick(), wait)
    this.timer?.unref?.()
  }

  #tick() {
    this.timer = undefined
    if (this.state !== CompanionState.IDLE) {
      this.#schedule(BUSY_RETRY_MS)
      return
    }
    this.speak()
    this.#schedule()
  }
}
