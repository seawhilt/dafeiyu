import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireLock, startDaemon } from '../src/daemon.js'
import { callDaemon, DaemonBridge } from '../src/daemon-client.js'
import { daemonPaths, loadSettings, readRuntime } from '../src/daemon-store.js'
import { createMessage } from '../src/protocol.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// Never run the real `claude /usage` in tests.
const noUsage = () => Promise.reject(new Error('no usage in tests'))

async function withDaemon(fn, { claude = true, queryUsage = noUsage, usageTimings } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-daemon-'))
  const paths = daemonPaths(home)
  const sent = []
  let helperOptions
  const daemon = await startDaemon({
    paths,
    logger: quiet,
    isClaudeConfigured: () => claude,
    queryUsage,
    ...(usageTimings ? { usageTimings } : {}),
    createHelper(options) {
      helperOptions = options
      return { start() {}, stop() {}, send: (message) => sent.push(message) }
    },
  })
  try {
    await fn({ paths, sent, daemon, helper: () => helperOptions })
  } finally {
    await daemon.close('test')
    rmSync(home, { recursive: true, force: true })
  }
}

const waitFor = async (check) => {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('condition not met in time')
}

test('runtime file is owner-only and removed on close', async () => {
  let runtimePath
  await withDaemon(async ({ paths }) => {
    runtimePath = paths.runtime
    assert.ok(readRuntime(paths).token.length >= 32)
    if (process.platform !== 'win32') {
      assert.equal(statSync(paths.runtime).mode & 0o777, 0o600)
    }
  })
  assert.equal(existsSync(runtimePath), false)
})

test('requests without the token are rejected', async () => {
  await withDaemon(async ({ paths }) => {
    const { port } = readRuntime(paths)
    const status = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/status' }, (res) => { res.resume(); resolve(res.statusCode) })
        .on('error', reject).end()
    })
    assert.equal(status, 401)
  })
})

test('Claude hook events drive the pet when Claude is the only provider', async () => {
  await withDaemon(async ({ paths, sent }) => {
    assert.deepEqual((await callDaemon('/status', undefined, { paths })).available, ['claude'])
    sent.length = 0
    await callDaemon('/claude/hook', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w/app' }, { paths })
    assert.equal(sent.find((message) => message.kind === 'state')?.state, 'THINKING')
  })
})

test('DSH registration adds DeepSeek, persists it, and the menu switch routes updates', async () => {
  await withDaemon(async ({ paths, sent, helper }) => {
    await callDaemon('/providers/deepseek/messages', {
      register: true,
      messages: [createMessage('state', { state: 'WORKING', message: 'ds working' })],
    }, { paths })
    const status = await callDaemon('/status', undefined, { paths })
    assert.deepEqual(status.available, ['claude', 'deepseek'])
    assert.equal(status.active, 'claude')
    assert.equal(loadSettings(paths).deepseekSeen, true)
    const config = sent.findLast((message) => message.kind === 'config')
    assert.deepEqual(config.providers.map((item) => item.id), ['claude', 'deepseek'])

    sent.length = 0
    helper().onSettingsChange({ provider: 'deepseek' })
    assert.equal(sent.find((message) => message.kind === 'state').message, 'ds working')
    assert.equal(loadSettings(paths).provider, 'deepseek')

    sent.length = 0
    await callDaemon('/claude/hook', { hook_event_name: 'UserPromptSubmit', session_id: 's' }, { paths })
    assert.deepEqual(sent, [], 'inactive provider stays off screen')

    await assert.rejects(callDaemon('/provider', { provider: 'nope' }, { paths }), /unknown provider/)
    assert.equal((await callDaemon('/provider', { provider: 'claude' }, { paths })).active, 'claude')
    assert.equal((await callDaemon('/forget', { provider: 'deepseek' }, { paths })).available.join(), 'claude')
  })
})

test('malformed provider messages are rejected', async () => {
  await withDaemon(async ({ paths }) => {
    await assert.rejects(
      callDaemon('/providers/deepseek/messages', { messages: [{ kind: 'state', state: 'BOGUS', protocolVersion: 1 }] }, { paths }),
      /Unknown companion state/,
    )
    await assert.rejects(callDaemon('/providers/other/messages', { messages: [] }, { paths }), /unknown provider/)
  }, { claude: false })
})

test('helper settings reports are persisted', async () => {
  await withDaemon(async ({ paths, helper }) => {
    helper().onSettingsChange({ scale: 1.25, reducedMotion: true, provider: 'deepseek' })
    const saved = loadSettings(paths)
    assert.equal(saved.scale, 1.25)
    assert.equal(saved.reducedMotion, true)
    assert.equal(saved.provider, null, 'an unconfigured provider is not saved')
    assert.equal(helper().env.DAFEIYU_SCALE, '0.6')
  })
})

test('DaemonBridge registers with a snapshot then streams updates', async () => {
  await withDaemon(async ({ paths, sent }) => {
    await callDaemon('/provider', { provider: 'claude' }, { paths })
    const bridge = new DaemonBridge({ paths, logger: quiet, autoStart: false })
    bridge.start()
    bridge.send(createMessage('hello', {}))
    bridge.send(createMessage('state', { state: 'THINKING', message: 'first' }))
    await waitFor(() => readFileSync(paths.config, 'utf8').includes('"deepseekSeen": true'))
    await callDaemon('/provider', { provider: 'deepseek' }, { paths })
    sent.length = 0
    bridge.send(createMessage('state', { state: 'WORKING', message: 'second' }))
    await waitFor(() => sent.some((message) => message.message === 'second'))
    bridge.stop('test')
    await waitFor(() => sent.some((message) => message.state === 'DISCONNECTED'))
  }, { claude: true })
})

test('Claude subscription usage from /usage shows in the bubble footer', async () => {
  let calls = 0
  const queryUsage = async () => {
    calls += 1
    return { session: { percent: 61, resets: '8:20pm' }, weekly: { percent: 36 } }
  }
  await withDaemon(async ({ sent }) => {
    await waitFor(() => sent.some((message) => message.kind === 'balance' && message.source === 'subscription'))
    assert.equal(sent.findLast((message) => message.kind === 'balance').summary, 'Claude 额度 会话 61% · 本周 36%')
    assert.equal(calls, 1, 'usage is read once at start, then on a timer')
  }, { queryUsage })
})

test('usage is not queried while Claude is not set up', async () => {
  let calls = 0
  await withDaemon(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls, 0)
  }, { claude: false, queryUsage: async () => { calls += 1; return {} } })
})

test('right-click chatter requests and level changes reach the scheduler', async () => {
  await withDaemon(async ({ paths, sent, helper }) => {
    sent.length = 0
    helper().onSettingsChange({ request: 'whisper' })
    assert.equal(sent.filter((message) => message.kind === 'say').length, 1)
    helper().onSettingsChange({ whisperLevel: 'high' })
    assert.equal(loadSettings(paths).whisperLevel, 'high')
    assert.equal(sent.findLast((message) => message.kind === 'config')?.whisperLevel ?? 'high', 'high')
  })
})

test('crossing a quota step says an urgent line while Claude is active', async () => {
  const readings = [{ session: { percent: 50 } }, { session: { percent: 96 } }]
  const queryUsage = async () => readings.shift() ?? { session: { percent: 96 } }
  await withDaemon(async ({ paths, sent }) => {
    await waitFor(() => sent.some((message) => message.kind === 'balance' && message.source === 'subscription'))
    sent.length = 0
    // A finished turn refreshes usage soon after.
    await callDaemon('/claude/hook', { hook_event_name: 'Stop', session_id: 's' }, { paths })
    await waitFor(() => sent.some((message) => message.kind === 'say' && message.urgent))
    const alert = sent.find((message) => message.kind === 'say' && message.urgent)
    assert.match(alert.message, /96%/)
    assert.equal(alert.clip, 'money_empty')
  }, { queryUsage, usageTimings: { pollMs: 60000, afterTurnMs: 10 } })
})

test('the single-instance lock is exclusive and reclaims dead owners', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-lock-'))
  try {
    const paths = daemonPaths(home)
    assert.equal(acquireLock(paths), true)
    assert.equal(acquireLock(paths), false)
    rmSync(paths.lock)
    writeFileSync(paths.lock, '999999999')
    assert.equal(acquireLock(paths), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
