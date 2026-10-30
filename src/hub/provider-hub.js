import { statePriority } from '../core/companion-reducer.js'
import {
  CompanionMessageKind,
  CompanionState,
  createMessage,
} from '../core/protocol.js'

export const PROVIDERS = Object.freeze({
  claude: Object.freeze({ id: 'claude', label: 'Claude' }),
  deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
})
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

export function isProviderId(value) {
  return PROVIDER_IDS.includes(value)
}

/** The user's source order: known ids once each, missing ones appended. */
export function normalizeOrder(order) {
  const known = Array.isArray(order) ? order.filter(isProviderId) : []
  return [...new Set([...known, ...PROVIDER_IDS])]
}

const labelOf = (provider) => PROVIDERS[provider]?.label ?? provider
const priorityOf = (stateValue) => statePriority[stateValue] ?? 0
const ACTIVE_STATES = new Set([
  CompanionState.THINKING,
  CompanionState.WORKING,
  CompanionState.WAITING,
  CompanionState.ERROR,
])

function idleState() {
  return createMessage(CompanionMessageKind.STATE, {
    state: CompanionState.IDLE,
    phase: 'provider-idle',
    stage: '等待任务',
    message: '我在这儿等新任务哦',
    detail: '等待下一次任务',
  })
}

const UNCONFIGURED_STATE = Object.freeze({
  state: CompanionState.DISCONNECTED,
  phase: 'no-provider',
  stage: '未配置',
  message: '还没有接入任何产品',
  detail: '运行 dafeiyu install claude，或在设置页接入',
})

const DISABLED_BALANCE = Object.freeze({ status: 'disabled', balances: [], summary: '' })

/**
 * Collects every source's latest snapshot and shows the one that needs the
 * user most: the most urgent state wins, ties follow the user's order. Tasks
 * from all sources merge into one list.
 */
export class ProviderHub {
  /**
   * @param {{ send: (message: object) => void, displaySettings?: () => object, order?: string[] }} options
   */
  constructor({ send, displaySettings = () => ({}), order }) {
    this.sendToPet = send
    this.displaySettings = displaySettings
    this.order = normalizeOrder(order)
    this.available = []
    this.displayed = null
    this.tasksSignature = undefined
    this.channels = new Map(PROVIDER_IDS.map((id) => [id, { snapshot: new Map(), open: { openUrl: '', openLabel: '' } }]))
  }

  get state() {
    return {
      displayed: this.displayed,
      available: [...this.available],
      order: [...this.order],
    }
  }

  receive(provider, message) {
    const channel = this.channels.get(provider)
    if (!channel) return
    switch (message?.kind) {
      case CompanionMessageKind.CONFIG:
        // Display settings belong to the shared pet; a source only owns how
        // the pet opens that source's client.
        channel.open = {
          openUrl: typeof message.openUrl === 'string' ? message.openUrl : '',
          openLabel: typeof message.openLabel === 'string' ? message.openLabel : '',
        }
        if (provider === this.displayed) this.sendToPet(this.configMessage())
        return
      case CompanionMessageKind.STATE:
        channel.snapshot.set(message.kind, message)
        if (!this.#redisplay() && provider === this.displayed) this.sendToPet(this.#labelled(provider, message))
        this.#sendTasks()
        return
      case CompanionMessageKind.TASKS:
        channel.snapshot.set(message.kind, message)
        this.#sendTasks()
        return
      case CompanionMessageKind.BALANCE:
        channel.snapshot.set(message.kind, message)
        if (provider === this.displayed) this.sendToPet(message)
        return
      case CompanionMessageKind.PULSE:
      case CompanionMessageKind.TASK:
        // A pulse resumes to the displayed state afterwards; one from another
        // source would resume to the wrong text.
        if (provider === this.displayed) this.sendToPet(this.#labelled(provider, message))
        return
      default:
    }
  }

  /** Sources that are both set up and enabled, in no particular order. */
  setAvailable(available) {
    const next = this.order.filter((id) => available.includes(id))
    if (next.join() === this.available.join()) return
    this.available = next
    if (!this.#redisplay()) this.replay()
  }

  setOrder(order) {
    const next = normalizeOrder(order)
    if (next.join() === this.order.join()) return
    this.order = next
    this.available = next.filter((id) => this.available.includes(id))
    this.tasksSignature = undefined
    if (!this.#redisplay()) this.#sendTasks()
  }

  /** Idle error snapshots of sources that have no reducer here to clear them. */
  dismissErrors() {
    let changed = false
    for (const id of this.available) {
      const { snapshot } = this.channels.get(id)
      if (snapshot.get(CompanionMessageKind.STATE)?.state !== CompanionState.ERROR) continue
      snapshot.set(CompanionMessageKind.STATE, idleState())
      snapshot.delete(CompanionMessageKind.TASKS)
      changed = true
    }
    if (changed && !this.#redisplay()) this.replay()
  }

  resetProvider(provider) {
    this.channels.get(provider)?.snapshot.clear()
    if (!this.#redisplay()) this.replay()
  }

  configMessage() {
    const open = this.displayed ? this.channels.get(this.displayed).open : { openUrl: '', openLabel: '' }
    return createMessage(CompanionMessageKind.CONFIG, { ...this.displaySettings(), ...open })
  }

  /** Resend the pet config after display settings change. */
  refreshConfig() {
    this.sendToPet(this.configMessage())
  }

  replay() {
    this.sendToPet(this.configMessage())
    this.tasksSignature = undefined
    if (!this.displayed) {
      this.sendToPet(createMessage(CompanionMessageKind.STATE, UNCONFIGURED_STATE))
      this.#sendTasks()
      this.sendToPet(createMessage(CompanionMessageKind.BALANCE, DISABLED_BALANCE))
      return
    }
    const { snapshot } = this.channels.get(this.displayed)
    this.sendToPet(this.#labelled(this.displayed, snapshot.get(CompanionMessageKind.STATE) ?? idleState()))
    this.#sendTasks()
    this.sendToPet(snapshot.get(CompanionMessageKind.BALANCE) ?? createMessage(CompanionMessageKind.BALANCE, DISABLED_BALANCE))
  }

  /** @returns {boolean} whether the displayed source changed (and was replayed) */
  #redisplay() {
    const next = this.#pick()
    if (next === this.displayed) return false
    this.displayed = next
    this.replay()
    return true
  }

  #pick() {
    let best = null
    for (const id of this.available) {
      if (best === null || priorityOf(this.#stateOf(id)) > priorityOf(this.#stateOf(best))) best = id
    }
    return best
  }

  #stateOf(provider) {
    return this.channels.get(provider).snapshot.get(CompanionMessageKind.STATE)?.state ?? CompanionState.IDLE
  }

  #labelled(provider, message) {
    const detail = message.detail ? `${labelOf(provider)} · ${message.detail}` : labelOf(provider)
    return { ...message, detail }
  }

  #mergedTasks() {
    const tasks = this.available.flatMap((id, rank) => {
      const { snapshot } = this.channels.get(id)
      const listed = snapshot.get(CompanionMessageKind.TASKS)?.tasks ?? []
      const current = snapshot.get(CompanionMessageKind.STATE)
      // A reducer lists its sessions only once it has two; one busy session
      // still belongs in the shared list.
      const own = listed.length > 0 || !ACTIVE_STATES.has(current?.state)
        ? listed
        : [{ sessionId: current.sessionId, state: current.state, project: current.project, task: current.task, message: current.message, detail: current.detail }]
      return own.map((task) => ({ ...task, source: labelOf(id), rank }))
    })
    return tasks
      .sort((left, right) => priorityOf(right.state) - priorityOf(left.state) || left.rank - right.rank)
      .map(({ rank: _rank, ...task }) => task)
  }

  #sendTasks() {
    const tasks = this.#mergedTasks()
    const signature = JSON.stringify(tasks)
    if (signature === this.tasksSignature) return
    this.tasksSignature = signature
    this.sendToPet(createMessage(CompanionMessageKind.TASKS, { tasks }))
  }
}
