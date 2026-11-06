// Limits and choices for the pet's display and motion settings, shared by the
// daemon, the settings page and the DSH plugin. The two helpers (Swift and
// Python) clamp to the same numbers.

// Size options are labelled by the source canvas width at that scale (640 px
// at 1.0), the same labels dsh-pet-indesktop uses.
export const CANVAS_WIDTH = 640
export const SCALE_STEPS = Object.freeze([0.5, 0.72, 0.85, 1])
export const DEFAULT_SCALE = 0.72
export const SCALE_RANGE = Object.freeze({ min: 0.5, max: 1.4 })
export const BUBBLE_SCALE_RANGE = Object.freeze({ min: 0.5, max: 3 })
export const OPACITY_RANGE = Object.freeze({ min: 10, max: 100 })
export const PLAYBACK_SPEEDS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4])
export const ANIMATION_GAP_MAX_SECONDS = 3600
export const THROW_STRENGTHS = Object.freeze(['gentle', 'standard', 'strong', 'crazy'])

/** "461 px" for 0.72. */
export const scaleLabel = (scale) => `${Math.round(CANVAS_WIDTH * scale)} px`
