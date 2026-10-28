import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CompanionMessageKind, CompanionState } from './protocol.js'
import { statusCopyLibrary } from './status-copy.js'
import { WHISPER_LINES } from './whisper-lines.js'

// User-edited bubble lines from the settings page, kept in config.json as
// `bubbleText`. Each group replaces its built-in lines; a missing or empty
// group keeps the defaults.
export const BUBBLE_GROUPS = Object.freeze({
  thinking: { label: '思考中', defaults: statusCopyLibrary.thinking },
  working: { label: '干活中', defaults: statusCopyLibrary.working },
  waiting: { label: '等你确认', defaults: statusCopyLibrary.waiting },
  done: { label: '完成', defaults: statusCopyLibrary.success },
  error: { label: '出错', defaults: statusCopyLibrary.error },
  chatter: { label: '碎碎念（空闲时）', defaults: WHISPER_LINES.generic },
})
const MAX_LINES = 50
const MAX_LINE_LENGTH = 60

const fileOf = (home) => join(home, 'bubble-text.json')

export function sanitizeBubbleText(value) {
  const clean = {}
  for (const key of Object.keys(BUBBLE_GROUPS)) {
    const lines = Array.isArray(value?.[key]) ? value[key] : []
    const kept = lines
      .filter((line) => typeof line === 'string')
      .map((line) => line.trim().slice(0, MAX_LINE_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_LINES)
    const unchanged = kept.length === BUBBLE_GROUPS[key].defaults.length
      && kept.every((line, index) => line === BUBBLE_GROUPS[key].defaults[index])
    if (kept.length > 0 && !unchanged) clean[key] = kept
  }
  return clean
}

/**
 * Earlier builds kept the lines in bubble-text.json; read them once so they
 * can move into config.json, then remove the file.
 */
export function takeLegacyBubbleText(home) {
  let legacy
  try {
    legacy = sanitizeBubbleText(JSON.parse(readFileSync(fileOf(home), 'utf8')))
  } catch {
    return undefined
  }
  rmSync(fileOf(home), { force: true })
  return legacy
}

/** Effective lines per group for the settings page. */
export function bubbleTextView(custom) {
  return Object.entries(BUBBLE_GROUPS).map(([key, group]) => ({
    key,
    label: group.label,
    lines: custom[key] ?? [...group.defaults],
    custom: Boolean(custom[key]),
  }))
}

function groupOf(message) {
  if (message.kind === CompanionMessageKind.PULSE) {
    if (message.state === CompanionState.SUCCESS) return 'done'
    if (message.state === CompanionState.ERROR) return 'error'
    return undefined
  }
  if (message.kind !== CompanionMessageKind.STATE) return undefined
  return {
    [CompanionState.THINKING]: 'thinking',
    [CompanionState.WORKING]: 'working',
    [CompanionState.WAITING]: 'waiting',
    [CompanionState.ERROR]: 'error',
  }[message.state]
}

/**
 * Swap a status message's line for one of the user's, picked by a stable
 * seed so repeated updates of one state do not flicker. `{task}` is replaced
 * with the current task when there is one.
 */
export function applyBubbleText(message, custom) {
  const group = groupOf(message)
  const lines = group ? custom[group] : undefined
  if (!lines) return message
  const seed = Math.abs(Number(message.sourceSeq ?? message.timestamp ?? 0)) || 0
  const line = lines[seed % lines.length].replaceAll('{task}', message.task ?? '当前任务')
  return { ...message, message: line }
}
