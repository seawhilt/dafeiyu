import { AnimationModel } from './animation-model.js'
import { CompanionMessageKind, createMessage } from './protocol.js'

// Drives the pet's animation from the daemon. It reads the same messages the
// helper gets (state, pulse, config, say), the helper's input reports and
// its end-of-pass reports, and sends `play` whenever the clip should change.
// The helper only renders.

const CLICK_LINES = Object.freeze({
  head_pat: '摸摸也不能让我少干活哦~',
  tail: '尾巴不是进度条啦！',
  poke: '戳我干嘛，任务还在跑呢',
})
const ANNOYED_LINE = '别戳啦！再戳我就生气了！'
const PAT_LINE = '好啦好啦，知道你喜欢我~'
const UNDOCK_LINE = '我出来啦~'
const DOCK_EDGES = new Set(['left', 'right'])
const LINE_TTL_MS = 1800
const ACTION_TTL_MS = 2500

/**
 * @param {{
 *   manifest: object,
 *   send: (message: object) => void,
 *   now?: () => number,
 *   random?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} options
 */
export function createPetDirector({ manifest, send, now = Date.now, random = Math.random, timers = { setTimeout, clearTimeout } }) {
  let model = new AnimationModel(manifest)
  let sentClip = null
  let reducedMotion = false
  let activityLevel = 'normal'
  let lastState = null
  let pulseTimer
  let microTimer
  // The screen edge the pet is docked on, or null.
  let docked = null
  let stopped = false

  const later = (delay, fn) => {
    const timer = timers.setTimeout(fn, Math.max(0, delay))
    timer?.unref?.()
    return timer
  }

  // A docked pet holds still; the clip catches up when it comes back out.
  const play = (force = false) => {
    if (docked) return
    if (!force && model.activeClip === sentClip) return
    sentClip = model.activeClip
    send(createMessage(CompanionMessageKind.PLAY, { clip: sentClip, loop: model.clip()?.loop === true }))
  }

  const sayLine = (text, ttlMs) => send(createMessage(CompanionMessageKind.SAY, { message: text, ttlMs, urgent: true }))

  const dock = (edge) => {
    timers.clearTimeout(microTimer)
    model.clearOverlay()
    play()
    docked = edge
    send(createMessage(CompanionMessageKind.DOCK, { edge }))
  }

  const undock = () => {
    docked = null
    send(createMessage(CompanionMessageKind.DOCK, { edge: null }))
    play(true)
  }

  const schedulePulseEnd = () => {
    timers.clearTimeout(pulseTimer)
    if (model.pulseDeadline === null) return
    pulseTimer = later(model.pulseDeadline - now(), () => {
      if (model.expirePulse(now())) play()
      scheduleMicro()
    })
  }

  // Idle actions: a random rest after the current overlay, only while idle.
  function scheduleMicro() {
    timers.clearTimeout(microTimer)
    if (stopped || docked || reducedMotion || model.baseState !== 'IDLE') return
    const [low, high] = model.idleInterval(activityLevel)
    microTimer = later(low + Math.floor(random() * (high - low)), () => {
      if (model.playIdleMicro(Math.floor(random() * Math.max(1, model.idleMicroClips.length)))) play()
      else scheduleMicro()
    })
  }

  const applyState = (message) => {
    lastState = message
    model.applyState(message.state, reducedMotion ? undefined : message.activity)
    schedulePulseEnd()
    play()
    scheduleMicro()
  }

  return {
    /** A new character: new clips, same agent state. */
    setManifest(next) {
      model = new AnimationModel(next)
      sentClip = null
      // The restarted helper comes back undocked.
      docked = null
      if (lastState) model.applyState(lastState.state, lastState.activity)
      play(true)
      scheduleMicro()
    },

    /** Every message bound for the helper passes through here first. */
    observe(message) {
      switch (message.kind) {
        case CompanionMessageKind.STATE:
          applyState(message)
          break
        case CompanionMessageKind.PULSE:
          model.applyPulse(message.state, Math.max(250, Number(message.ttlMs) || 1800), now(),
            message.resumeState, message.resumeActivity, !reducedMotion)
          schedulePulseEnd()
          play()
          break
        case CompanionMessageKind.CONFIG:
          if (typeof message.reducedMotion === 'boolean') reducedMotion = message.reducedMotion
          if (['quiet', 'normal', 'lively'].includes(message.activityLevel)) activityLevel = message.activityLevel
          scheduleMicro()
          break
        case CompanionMessageKind.SAY: {
          const idle = model.baseState === 'IDLE' && model.pulseState === null && model.overlayClip === null
          if (!idle || reducedMotion) break
          const clip = typeof message.clip === 'string' && model.clips.has(message.clip) ? message.clip : undefined
          if (clip ? model.playOverlay(clip) : model.playIdleMicro(Math.floor(random() * 8))) play()
          break
        }
        default:
          break
      }
    },

    /** The helper finished a pass of `clip`. */
    passEnded(clip) {
      if (model.passEnded(clip)) {
        play()
        if (model.overlayClip === null) scheduleMicro()
      }
    },

    /** Clicks, drags and menu actions reported by the helper. */
    input(report) {
      const at = now()
      // Any touch on a docked pet brings it back out; a drag carries it off.
      if (docked && report?.type !== 'drag-end') {
        undock()
        if (report?.type !== 'drag-start') {
          sayLine(UNDOCK_LINE, LINE_TTL_MS)
          scheduleMicro()
          return
        }
      }
      switch (report?.type) {
        case 'click': {
          const region = Object.hasOwn(CLICK_LINES, report.region) ? report.region : 'poke'
          const clip = model.pickInteraction(region, at)
          const annoyed = model.annoyedClips.includes(clip)
          if (!reducedMotion && !model.playInteraction(clip, at)) return
          play()
          sayLine(annoyed ? ANNOYED_LINE : CLICK_LINES[region], LINE_TTL_MS)
          break
        }
        case 'double-click':
          if (!reducedMotion && !model.playInteraction('head_pat', at)) return
          play()
          sayLine(PAT_LINE, LINE_TTL_MS)
          break
        case 'drag-start':
          timers.clearTimeout(microTimer)
          if (model.playOverlay('dragging')) play()
          break
        case 'drag-end':
          // A long drag may have outlived the pulse underneath it.
          model.expirePulse(at)
          if (DOCK_EDGES.has(report.edge)) {
            dock(report.edge)
            break
          }
          if (reducedMotion || !model.playOverlay('dragging_release')) model.clearOverlay()
          play()
          break
        case 'action': {
          if (typeof report.clip !== 'string' || model.pulseState !== null) return
          if (model.interactionClips.has(report.clip)) {
            if (!reducedMotion && !model.playInteraction(report.clip, at)) return
          } else if (!reducedMotion && !model.playOverlay(report.clip)) {
            return
          }
          play()
          if (typeof report.line === 'string' && report.line) sayLine(report.line.slice(0, 80), ACTION_TTL_MS)
          break
        }
        default:
          break
      }
    },

    /** Send the current clip again, e.g. to a restarted helper. */
    replay: () => play(true),

    get activeClip() {
      return model.activeClip
    },

    get docked() {
      return docked
    },

    stop() {
      stopped = true
      timers.clearTimeout(pulseTimer)
      timers.clearTimeout(microTimer)
    },
  }
}
