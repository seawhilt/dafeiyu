import {
  CompanionMessageKind,
  CompanionState,
  createMessage,
} from './protocol.js'

export const PROVIDERS = Object.freeze({
  claude: Object.freeze({ id: 'claude', label: 'Claude' }),
  deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
})
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

export function isProviderId(value) {
  return PROVIDER_IDS.includes(value)
}

/**
 * The saved choice wins while it stays configured; otherwise fall back to the
 * first configured provider in a fixed order.
 * @param {string | null | undefined} preferred
 * @param {string[]} available
 * @returns {string | null}
 */
export function resolveActiveProvider(preferred, available) {
  if (available.includes(preferred)) return preferred
  return PROVIDER_IDS.find((id) => available.includes(id)) ?? null
}

// Kinds whose latest value describes "what the pet should show now" for a
// provider. Pulses are momentary and only reach the pet while live.
const SNAPSHOT_KINDS = new Set([
  CompanionMessageKind.STATE,
  CompanionMessageKind.TASKS,
  CompanionMessageKind.BALANCE,
])
const ACCEPTED_KINDS = new Set([
  ...SNAPSHOT_KINDS,
  CompanionMessageKind.PULSE,
  CompanionMessageKind.TASK,
  CompanionMessageKind.CONFIG,
])

function idleState(provider) {
  const label = PROVIDERS[provider]?.label ?? provider
  return createMessage(CompanionMessageKind.STATE, {
    state: CompanionState.IDLE,
    phase: 'provider-idle',
    stage: '等待任务',
    message: '我在这儿等新任务哦',
    detail: `${label} · 等待下一次任务`,
  })
}

const UNCONFIGURED_STATE = Object.freeze({
  state: CompanionState.DISCONNECTED,
  phase: 'no-provider',
  stage: '未配置',
  message: '还没有可用的服务商',
  detail: '运行 dafeiyu install-claude，或在 DSH 安装插件',
})

/**
 * Keeps one snapshot per provider and forwards only the active provider's
 * messages to the pet. Switching replays the new provider's latest snapshot,
 * so no state from the previous provider lingers on screen.
 */
export class ProviderHub {
  /**
   * @param {{ send: (message: object) => void, displaySettings?: () => object, preferred?: string | null }} options
   */
  constructor({ send, displaySettings = () => ({}), preferred = null }) {
    this.sendToPet = send
    this.displaySettings = displaySettings
    this.preferred = preferred
    this.available = []
    this.active = null
    this.channels = new Map(PROVIDER_IDS.map((id) => [id, { snapshot: new Map(), open: { openUrl: '', openLabel: '' } }]))
  }

  get state() {
    return {
      active: this.active,
      available: [...this.available],
      providers: this.available.map((id) => PROVIDERS[id]),
    }
  }

  receive(provider, message) {
    const channel = this.channels.get(provider)
    if (!channel || !ACCEPTED_KINDS.has(message?.kind)) return
    if (message.kind === CompanionMessageKind.CONFIG) {
      // Display settings belong to the shared pet; a provider only owns how
      // the pet opens that provider's client.
      channel.open = {
        openUrl: typeof message.openUrl === 'string' ? message.openUrl : '',
        openLabel: typeof message.openLabel === 'string' ? message.openLabel : '',
      }
      if (provider === this.active) this.sendToPet(this.configMessage())
      return
    }
    if (SNAPSHOT_KINDS.has(message.kind)) channel.snapshot.set(message.kind, message)
    if (provider === this.active) this.sendToPet(message)
  }

  /** @returns {boolean} whether the active provider changed */
  setAvailable(available) {
    const next = PROVIDER_IDS.filter((id) => available.includes(id))
    const listChanged = next.join() !== this.available.join()
    this.available = next
    const changed = this.#activate(resolveActiveProvider(this.preferred ?? this.active, next))
    if (listChanged && !changed) this.sendToPet(this.configMessage())
    return changed
  }

  /** @returns {boolean} whether the selection was accepted */
  select(provider) {
    if (!this.available.includes(provider)) return false
    this.preferred = provider
    this.#activate(provider)
    return true
  }

  resetProvider(provider) {
    this.channels.get(provider)?.snapshot.clear()
    if (provider === this.active) this.replay()
  }

  configMessage() {
    const open = this.active ? this.channels.get(this.active).open : { openUrl: '', openLabel: '' }
    return createMessage(CompanionMessageKind.CONFIG, {
      ...this.displaySettings(),
      ...open,
      providers: this.available.map((id) => PROVIDERS[id]),
      provider: this.active,
    })
  }

  /** Resend the pet config after display settings change. */
  refreshConfig() {
    this.sendToPet(this.configMessage())
  }

  replay() {
    this.sendToPet(this.configMessage())
    if (!this.active) {
      this.sendToPet(createMessage(CompanionMessageKind.STATE, UNCONFIGURED_STATE))
      this.sendToPet(createMessage(CompanionMessageKind.TASKS, { tasks: [] }))
      this.sendToPet(createMessage(CompanionMessageKind.BALANCE, { status: 'disabled', balances: [], summary: '' }))
      return
    }
    const { snapshot } = this.channels.get(this.active)
    this.sendToPet(snapshot.get(CompanionMessageKind.STATE) ?? idleState(this.active))
    this.sendToPet(snapshot.get(CompanionMessageKind.TASKS) ?? createMessage(CompanionMessageKind.TASKS, { tasks: [] }))
    this.sendToPet(snapshot.get(CompanionMessageKind.BALANCE)
      ?? createMessage(CompanionMessageKind.BALANCE, { status: 'disabled', balances: [], summary: '' }))
  }

  #activate(provider) {
    if (provider === this.active) return false
    this.active = provider
    this.replay()
    return true
  }
}
