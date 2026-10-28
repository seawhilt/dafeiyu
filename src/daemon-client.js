import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonPaths, readRuntime } from './daemon-store.js'
import { CompanionMessageKind, CompanionState, createMessage } from './protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
export const cliPath = resolve(here, '..', 'bin', 'dafeiyu.mjs')
const START_WAIT_MS = 4000
const START_POLL_MS = 100

/**
 * POST (or GET when body is undefined) to the running daemon.
 * Rejects when the daemon is not running or answers with an error status.
 */
export function callDaemon(path, body, { paths = daemonPaths(), timeoutMs = 1500, method } = {}) {
  const runtime = readRuntime(paths)
  if (!runtime) return Promise.reject(Object.assign(new Error('daemon is not running'), { code: 'NOT_RUNNING' }))
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolvePromise, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: runtime.port,
      path,
      method: method ?? (payload ? 'POST' : 'GET'),
      headers: {
        'x-dafeiyu-token': runtime.token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let value
        try { value = text ? JSON.parse(text) : {} } catch { value = { error: text } }
        if ((res.statusCode ?? 500) >= 400) {
          reject(Object.assign(new Error(value?.error || `daemon answered ${res.statusCode}`), { code: 'HTTP', status: res.statusCode }))
        } else {
          resolvePromise(value)
        }
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('daemon request timed out'), { code: 'TIMEOUT' })))
    req.on('error', (error) => reject(Object.assign(error, { code: error.code ?? 'NOT_RUNNING' })))
    req.end(payload)
  })
}

export function spawnDaemon({ env = process.env } = {}) {
  try {
    const child = spawn(process.execPath, [cliPath, 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    })
    // A bootstrap failure must surface as "daemon did not start" to the caller,
    // never as an unhandled child-process error in the hook.
    child.on('error', () => {})
    child.unref()
  } catch {}
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

/** Start the daemon when it is not answering, then wait until it does. */
export async function ensureDaemon({ paths = daemonPaths(), waitMs = START_WAIT_MS } = {}) {
  try {
    return await callDaemon('/status', undefined, { paths })
  } catch {}
  spawnDaemon({ env: { ...process.env, DAFEIYU_HOME: paths.home } })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS)
    try {
      return await callDaemon('/status', undefined, { paths })
    } catch {}
  }
  throw Object.assign(new Error('daemon did not start in time'), { code: 'START_TIMEOUT' })
}

const SNAPSHOT_KINDS = new Set([
  CompanionMessageKind.STATE,
  CompanionMessageKind.TASKS,
  CompanionMessageKind.BALANCE,
  CompanionMessageKind.CONFIG,
])
const RETRY_MS = 3000

/**
 * Drop-in replacement for HelperProcess used by the DSH plugin in shared
 * mode: messages go to the shared daemon instead of a private pet window.
 * Snapshot kinds are coalesced and resent after the daemon (re)appears.
 */
export class DaemonBridge {
  constructor({ provider = 'deepseek', paths = daemonPaths(), logger = console, autoStart = true } = {}) {
    this.provider = provider
    this.paths = paths
    this.logger = logger
    this.autoStart = autoStart
    this.snapshot = new Map()
    this.pending = []
    this.connected = false
    this.stopped = true
    this.flushing = undefined
    this.retryTimer = undefined
  }

  start() {
    this.stopped = false
    this.#schedule()
  }

  send(message) {
    if (this.stopped) return
    if (SNAPSHOT_KINDS.has(message.kind)) this.snapshot.set(message.kind, message)
    if (message.kind === CompanionMessageKind.HELLO) return
    this.pending.push(message)
    this.#schedule()
  }

  stop(reason = 'plugin-disposed') {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.retryTimer)
    const goodbye = createMessage(CompanionMessageKind.STATE, {
      state: CompanionState.DISCONNECTED,
      phase: 'host-stopped',
      stage: '已退出',
      message: 'DSH 已退出',
      detail: `DSH · ${reason}`,
    })
    void this.#post([goodbye]).catch(() => {})
  }

  #schedule() {
    if (this.flushing || this.retryTimer || this.stopped) return
    this.flushing = Promise.resolve().then(() => this.#flush()).finally(() => { this.flushing = undefined })
  }

  async #flush() {
    while (!this.stopped) {
      const register = !this.connected
      // On (re)connect the snapshot already carries everything queued so far;
      // stale pulses would replay finished moments.
      const batch = register ? [...this.snapshot.values()] : this.pending
      this.pending = []
      if (!register && batch.length === 0) return
      try {
        await this.#post(batch, { register })
        this.connected = true
      } catch (error) {
        this.connected = false
        this.pending = []
        if (error?.code !== 'HTTP' && this.autoStart) {
          try { await ensureDaemon({ paths: this.paths }) } catch (startError) {
            this.logger.warn?.(`agent-dafeiyu could not reach the shared pet daemon: ${startError.message}`)
          }
        }
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined
          this.#schedule()
        }, RETRY_MS)
        this.retryTimer.unref?.()
        return
      }
    }
  }

  #post(messages, { register = false } = {}) {
    return callDaemon(`/providers/${this.provider}/messages`, { messages, register }, { paths: this.paths })
  }
}
