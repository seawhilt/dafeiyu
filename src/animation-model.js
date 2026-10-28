// Which clip the pet should play, decided in one place for every helper.
//
// Port of the helpers' former AnimationModel. The helper plays the clip it is
// told and reports when a pass ends; this model reacts to those reports, to
// agent states and to the user's input. Durable agent state (base) is kept
// apart from short overlays (clicks, idle actions, drag) and pulses
// (completion, error), so an overlay always returns to the newest state.

export const STATES = new Set(['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'DISCONNECTED'])
export const DRAG_CLIPS = new Set(['dragging', 'dragging_release'])
const BASE_INTERACTIONS = ['head_pat', 'poke', 'tail']
const RAPID_CLICKS = 3
const RAPID_CLICK_WINDOW_MS = 3000

/** Fade clip changes only; never blend successive frames of one clip. */
export function crossfadeMs(previousClip, currentClip) {
  if (previousClip === currentClip || DRAG_CLIPS.has(previousClip) || DRAG_CLIPS.has(currentClip)) return 0
  return 100
}

export class AnimationModel {
  constructor(manifest) {
    this.clips = new Map(Object.entries(manifest.clips ?? {}).map(([name, clip]) => [name, {
      name,
      frameCount: clip.frames?.length ?? 0,
      frameMs: Number(clip.frameMs) || 42,
      loop: clip.loop === true,
    }]))
    this.stateMap = { ...manifest.stateMap }
    this.activityMap = { ...manifest.workingActivityMap }
    this.idleMicroClips = (manifest.idleMicroClips ?? []).filter((name) => this.clips.has(name))
    this.idleMicroIntervals = manifest.idleMicroIntervalsMs ?? { quiet: [20000, 40000], normal: [8000, 15000], lively: [3000, 6000] }
    this.cooldownMs = Number(manifest.interactionCooldownMs) || 1200
    const pick = (names) => (names ?? []).filter((name) => this.clips.has(name))
    this.interactionVariants = Object.fromEntries(Object.entries(manifest.interactionVariants ?? {}).map(([k, v]) => [k, pick(v)]))
    this.annoyedClips = this.interactionVariants.annoyed ?? []
    this.interactionClips = new Set([...BASE_INTERACTIONS, ...Object.values(this.interactionVariants).flat()])
    this.loopVariants = Object.fromEntries(Object.entries(manifest.loopVariants ?? {}).map(([k, v]) => [k, pick(v)]))

    this.baseState = 'IDLE'
    this.basePrimary = this.stateMap.IDLE ?? 'idle'
    this.baseClip = this.basePrimary
    this.overlayClip = null
    this.pulseState = null
    this.pulseClip = null
    this.pulseDeadline = null
    this.lastInteractionAt = null
    this.lastIdleMicro = null
    this.recentClicks = []
    this.variantIndex = {}
    this.activeClip = this.baseClip
  }

  clip(name = this.activeClip) {
    return this.clips.get(name)
  }

  durationMs(name) {
    const clip = this.clips.get(name)
    return clip ? clip.frameCount * clip.frameMs : 0
  }

  applyState(state, activity) {
    if (!STATES.has(state)) return
    this.baseState = state
    this.#setBase(this.#clipFor(state, activity))
    // Repeated idle snapshots must not cancel a completion reaction.
    if (state !== 'IDLE') {
      this.pulseState = null
      this.pulseClip = null
      this.pulseDeadline = null
      if (!DRAG_CLIPS.has(this.overlayClip)) this.overlayClip = null
    }
    if (this.overlayClip === null) this.activeClip = this.#underlay()
  }

  applyPulse(state, ttlMs, now, resumeState, resumeActivity, completeClip = true) {
    if (!STATES.has(state) || !(ttlMs > 0)) return
    if (STATES.has(resumeState)) {
      this.baseState = resumeState
      this.#setBase(this.#clipFor(resumeState, resumeActivity))
    }
    const previousDeadline = this.pulseState === state ? this.pulseDeadline : null
    this.pulseState = state
    this.pulseClip = this.#clipFor(state)
    const duration = completeClip ? this.durationMs(this.pulseClip) : 0
    this.pulseDeadline = Math.max(now + ttlMs, previousDeadline ?? now + duration)
    if (!DRAG_CLIPS.has(this.overlayClip)) this.overlayClip = null
    if (this.overlayClip === null) this.activeClip = this.pulseClip
  }

  /** The pulse ran out; back to the agent state. */
  expirePulse(now) {
    if (this.pulseDeadline === null || now < this.pulseDeadline) return false
    this.pulseState = null
    this.pulseClip = null
    this.pulseDeadline = null
    if (this.overlayClip === null) this.activeClip = this.baseClip
    return true
  }

  playOverlay(name) {
    if (!this.clips.has(name)) return false
    this.overlayClip = name
    this.activeClip = name
    return true
  }

  clearOverlay() {
    this.overlayClip = null
    this.activeClip = this.#underlay()
  }

  /** Clip for a click on `region`: cycles its variants; rapid clicks annoy. */
  pickInteraction(region, now) {
    this.recentClicks = [...this.recentClicks.filter((at) => now - at < RAPID_CLICK_WINDOW_MS), now]
    if (this.annoyedClips.length > 0 && this.recentClicks.length >= RAPID_CLICKS) {
      this.recentClicks = []
      return this.annoyedClips[0]
    }
    const variants = this.interactionVariants[region]?.length ? this.interactionVariants[region] : [region]
    const index = this.variantIndex[region] ?? 0
    this.variantIndex[region] = index + 1
    return variants[index % variants.length]
  }

  playInteraction(name, now) {
    if (!this.interactionClips.has(name) || this.pulseState !== null) return false
    if (DRAG_CLIPS.has(this.overlayClip)) return false
    // An annoyed reaction may cut into a running one; others wait their turn.
    if (!this.annoyedClips.includes(name)) {
      if (this.interactionClips.has(this.overlayClip)) return false
      if (this.lastInteractionAt !== null && now - this.lastInteractionAt < this.cooldownMs) return false
    }
    if (!this.playOverlay(name)) return false
    this.lastInteractionAt = now
    return true
  }

  playIdleMicro(index = 0) {
    if (this.baseState !== 'IDLE' || this.overlayClip !== null || this.pulseState !== null) return false
    if (this.idleMicroClips.length === 0) return false
    let name = this.idleMicroClips[index % this.idleMicroClips.length]
    if (this.idleMicroClips.length > 1 && name === this.lastIdleMicro) {
      name = this.idleMicroClips[(index + 1) % this.idleMicroClips.length]
    }
    this.lastIdleMicro = name
    return this.playOverlay(name)
  }

  idleInterval(level) {
    const [low, high] = this.idleMicroIntervals[level] ?? this.idleMicroIntervals.normal
    return [Number(low), Number(high)]
  }

  /**
   * The helper reached the end of a pass of `name`. Returns true when the
   * active clip changed. Reports for a clip that is no longer active are
   * stale and ignored.
   */
  passEnded(name) {
    if (name !== this.activeClip) return false
    if (this.overlayClip === name && !this.clip(name)?.loop) {
      this.clearOverlay()
      return true
    }
    return this.#rotateBase()
  }

  #setBase(primary) {
    // The same state keeps its current variant so repeated events do not
    // restart the animation.
    if (primary === this.basePrimary && (this.loopVariants[primary] ?? []).includes(this.baseClip)) return
    this.basePrimary = primary
    this.baseClip = primary
  }

  #rotateBase() {
    if (this.overlayClip !== null || this.pulseClip !== null || this.activeClip !== this.baseClip) return false
    const variants = this.loopVariants[this.basePrimary] ?? []
    if (variants.length < 2) return false
    const index = variants.indexOf(this.baseClip)
    this.baseClip = variants[(index + 1) % variants.length]
    this.activeClip = this.baseClip
    return true
  }

  #clipFor(state, activity) {
    if (state === 'WORKING' && activity && this.activityMap[activity]) return this.activityMap[activity]
    return this.stateMap[state] ?? this.stateMap.IDLE
  }

  #underlay() {
    return this.pulseClip ?? this.baseClip
  }
}
