// Reads Claude subscription usage on a timer and shortly after each turn.
// One query runs at a time; failures are logged and retried on the next tick.

export const USAGE_POLL_MS = 5 * 60 * 1000
export const USAGE_AFTER_TURN_MS = 20 * 1000

/**
 * @param {{
 *   query: () => Promise<object>,
 *   enabled: () => boolean,
 *   onUsage: (usage: object) => void,
 *   timings?: { pollMs: number, afterTurnMs: number },
 *   logger?: Console,
 * }} options
 */
export function createUsagePoller({
  query,
  enabled,
  onUsage,
  timings = { pollMs: USAGE_POLL_MS, afterTurnMs: USAGE_AFTER_TURN_MS },
  logger = console,
}) {
  let timer
  let pending = false
  let stopped = false

  const refresh = async () => {
    if (pending || stopped || !enabled()) return
    pending = true
    try {
      const usage = await query()
      if (!stopped) onUsage(usage)
    } catch (error) {
      logger.warn?.(`dafeiyu could not read Claude usage: ${error.message}`)
    } finally {
      pending = false
    }
  }

  const schedule = (delay) => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => {
      void refresh().finally(() => schedule(timings.pollMs))
    }, delay)
    timer.unref?.()
  }

  return {
    start: () => schedule(0),
    /** A finished turn changes usage; read it again soon. */
    afterTurn: () => schedule(timings.afterTurnMs),
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
