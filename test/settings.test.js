import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { startDaemon } from '../src/daemon.js'
import { callDaemon } from '../src/daemon-client.js'
import { daemonPaths, loadSettings, readRuntime } from '../src/daemon-store.js'
import { openInBrowser, settingsPage } from '../src/settings-routes.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// Never touch the real ~/.claude/settings.json or open a real browser.
async function withDaemon(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-settings-'))
  const paths = daemonPaths(join(dir, 'home'))
  const claudeSettingsPath = join(dir, 'claude-settings.json')
  writeFileSync(claudeSettingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }))
  const sent = []
  const opened = []
  let helperOptions
  const daemon = await startDaemon({
    paths,
    logger: quiet,
    claudeSettingsPath,
    openUrl: (url) => opened.push(url),
    queryUsage: () => Promise.reject(new Error('no usage in tests')),
    createHelper(options) {
      helperOptions = options
      return { start() {}, stop() {}, send: (message) => sent.push(message) }
    },
  })
  try {
    await fn({ paths, sent, opened, daemon, claudeSettingsPath, helper: () => helperOptions })
  } finally {
    await daemon.close('test')
    rmSync(dir, { recursive: true, force: true })
  }
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject).end()
  })
}

test('the page is served with a nonce-based CSP and no token inside', async () => {
  await withDaemon(async ({ paths }) => {
    const { port, token } = readRuntime(paths)
    const page = await rawGet(port, '/settings')
    assert.equal(page.status, 200)
    assert.match(page.headers['content-type'], /text\/html/)
    const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1]
    assert.ok(nonce)
    assert.ok(page.body.includes(`<script nonce="${nonce}">`))
    assert.ok(!page.body.includes('__NONCE__'))
    assert.ok(!page.body.includes(token), 'the token only travels in the URL fragment')
    assert.equal(page.headers['x-frame-options'], 'DENY')
    assert.ok(!/style="/.test(page.body), 'inline style attributes would be blocked by the CSP')
  })
})

test('a different origin is rejected even with the token', async () => {
  await withDaemon(async ({ paths }) => {
    const { port, token } = readRuntime(paths)
    const foreign = await rawGet(port, '/config', { 'x-dafeiyu-token': token, origin: 'http://evil.example' })
    assert.equal(foreign.status, 403)
    const same = await rawGet(port, '/config', { 'x-dafeiyu-token': token, origin: `http://127.0.0.1:${port}` })
    assert.equal(same.status, 200)
    assert.equal((await rawGet(port, '/config')).status, 401)
  })
})

test('config reports what is and is not set up', async () => {
  await withDaemon(async ({ paths, claudeSettingsPath }) => {
    const config = await callDaemon('/config', undefined, { paths })
    assert.equal(config.claude.hooksInstalled, false)
    assert.equal(config.claude.settingsPath, claudeSettingsPath)
    assert.equal(config.claude.lastEventAt, null)
    assert.equal(config.deepseek.connected, false)
    assert.match(config.deepseek.packageFile, /^agent-dafeiyu-.+\.tgz$/)
    assert.equal(config.deepseek.releaseUrl, 'https://github.com/seawhilt/dafeiyu/releases/latest')
    assert.deepEqual(config.available, [])
    assert.equal(config.settings.whisperLevel, 'low')

    await callDaemon('/claude/hook', { hook_event_name: 'UserPromptSubmit', session_id: 's' }, { paths })
    assert.ok((await callDaemon('/config', undefined, { paths })).claude.lastEventAt > 0)
  })
})

test('one-click Claude install and removal edit only the given settings file', async () => {
  await withDaemon(async ({ paths, claudeSettingsPath }) => {
    const installed = await callDaemon('/claude/install', {}, { paths })
    assert.equal(installed.claude.hooksInstalled, true)
    assert.ok(installed.available.includes('claude'))
    assert.match(readFileSync(claudeSettingsPath, 'utf8'), /dafeiyu-hook/)

    const removed = await callDaemon('/claude/uninstall', {}, { paths })
    assert.equal(removed.claude.hooksInstalled, false)
    assert.deepEqual(JSON.parse(readFileSync(claudeSettingsPath, 'utf8')).statusLine, { type: 'command', command: 'echo hi' }, 'the status line is never touched')
  })
})

test('an unreadable Claude settings file is reported, not overwritten', async () => {
  await withDaemon(async ({ paths, claudeSettingsPath }) => {
    writeFileSync(claudeSettingsPath, '{ broken')
    const config = await callDaemon('/config', undefined, { paths })
    assert.equal(config.claude.readable, false)
    await assert.rejects(callDaemon('/claude/install', {}, { paths }), /无法写入 Claude 设置/)
    assert.equal(readFileSync(claudeSettingsPath, 'utf8'), '{ broken')
  })
})

test('display settings are validated, saved and pushed to the pet live', async () => {
  await withDaemon(async ({ paths, sent }) => {
    sent.length = 0
    const next = await callDaemon('/config', { patch: { scale: 9, activityLevel: 'lively', whisperLevel: 'off' } }, { paths })
    assert.equal(next.settings.scale, 1.4, 'out-of-range values are clamped')
    assert.equal(next.settings.activityLevel, 'lively')
    assert.equal(loadSettings(paths).whisperLevel, 'off')
    const config = sent.findLast((message) => message.kind === 'config')
    assert.equal(config.scale, 1.4)
    assert.equal(config.activityLevel, 'lively')

    await assert.rejects(callDaemon('/config', { patch: { provider: 'claude' } }, { paths }), /unknown setting/)
    await assert.rejects(callDaemon('/config', { patch: 'x' }, { paths }), /patch must be an object/)
    assert.equal((await callDaemon('/config', { patch: { activityLevel: 'wild' } }, { paths })).settings.activityLevel, 'normal')
  })
})

test('the right-click request and the CLI route open the page with the token in the fragment', async () => {
  await withDaemon(async ({ paths, opened, helper }) => {
    helper().onSettingsChange({ request: 'settings' })
    await callDaemon('/settings/open', {}, { paths })
    const { port, token } = readRuntime(paths)
    assert.deepEqual(opened, [`http://127.0.0.1:${port}/settings#${token}`, `http://127.0.0.1:${port}/settings#${token}`])
  })
})

test('openInBrowser uses the platform opener without a shell', () => {
  const calls = []
  const run = (command, args) => {
    calls.push([command, args])
    return { on() {}, unref() {} }
  }
  openInBrowser('http://127.0.0.1:1/settings#t', { platform: 'darwin', run })
  openInBrowser('http://127.0.0.1:1/settings#t', { platform: 'linux', run })
  openInBrowser('http://127.0.0.1:1/settings#t', { platform: 'win32', run })
  assert.deepEqual(calls.map(([command]) => command), ['open', 'xdg-open', 'cmd'])
  assert.equal(calls[0][1][0], 'http://127.0.0.1:1/settings#t')
})

test('every page element the script reads exists', () => {
  const { html } = settingsPage()
  const ids = [...html.matchAll(/\$\('([a-z-]+)'\)/gu)].map((match) => match[1])
  const dynamic = new Set(['scale-value', 'bubbleScale-value'])
  for (const id of new Set(ids)) {
    if (dynamic.has(id)) continue
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`)
  }
})

test('bubble text saved from the page lives in config.json', async () => {
  await withDaemon(async ({ paths }) => {
    const view = await callDaemon('/bubble-text', { groups: { done: ['搞定！'] } }, { paths })
    assert.equal(view.find((group) => group.key === 'done').custom, true)
    assert.deepEqual(loadSettings(paths).bubbleText, { done: ['搞定！'] })
    await callDaemon('/bubble-text', { groups: {} }, { paths })
    assert.deepEqual(loadSettings(paths).bubbleText, {})
  })
})

// The settings page is a classic inline script, so a small DOM shim is enough
// to exercise its runtime cleanup: timers, object URLs and segmented buttons
// need behavior, not a browser. Every element lookup returns an inert stub, so
// these tests never depend on the page markup beyond what the script reads.
function loadSettingsPage({ hash = '', fetchImpl } = {}) {
  const { html } = settingsPage()
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1]
  assert.ok(script, 'settings.html keeps one nonce-guarded inline script')

  const images = []
  const intervals = new Map()
  const revoked = []
  const createdUrls = []
  const bodyClasses = { add: [], remove: [] }
  const draws = []
  let nextInterval = 1
  let nextUrl = 1

  const makeElement = (tag = 'div') => ({
    tagName: tag,
    children: [],
    dataset: {},
    attributes: {},
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    disabled: false,
    value: '',
    checked: false,
    textContent: '',
    width: 0,
    height: 0,
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    replaceChildren(...nodes) { this.children = nodes },
    append(...nodes) { this.children.push(...nodes) },
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] },
    getContext() { return { clearRect() {}, drawImage() { draws.push(true) } } },
    click() { for (const handler of this.listeners.click ?? []) handler() },
  })

  const elements = new Map()
  const document = {
    body: makeElement('body'),
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement())
      return elements.get(id)
    },
    createElement: (tag) => makeElement(tag),
    querySelectorAll: () => [],
  }
  document.body.classList = {
    add(name) { bodyClasses.add.push(name) },
    remove(name) { bodyClasses.remove.push(name) },
    toggle() {},
  }
  const windowListeners = {}
  const sandbox = {
    console,
    location: { hash, pathname: '/settings' },
    history: { replaceState() {} },
    document,
    window: { addEventListener(type, handler) { (windowListeners[type] ??= []).push(handler) } },
    // Tests fire image.onload themselves so "stopped before the image loaded"
    // and "running interval" are both observable.
    Image: class { constructor() { images.push(this) } set src(value) { this._src = value } },
    URL: {
      createObjectURL() { const url = `blob:test-${nextUrl++}`; createdUrls.push(url); return url },
      revokeObjectURL(url) { revoked.push(url) },
    },
    setInterval(callback) { const id = nextInterval++; intervals.set(id, callback); return id },
    clearInterval(id) { intervals.delete(id) },
    setTimeout() { return 0 },
    clearTimeout() {},
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }
  runInNewContext(script, sandbox)
  return {
    sandbox,
    elements,
    images,
    intervals,
    revoked,
    createdUrls,
    bodyClasses,
    draws,
    element: makeElement,
    pageHide() { for (const handler of windowListeners.pagehide ?? []) handler() },
  }
}

const SETTINGS_PAGE_CONFIG = {
  version: '0.0.0-test',
  active: null,
  available: [],
  settings: { scale: 1, bubbleScale: 1, activityLevel: 'normal', whisperLevel: 'low', bubbleMode: 'auto', reducedMotion: false, soundEnabled: true },
  claude: { hooksInstalled: false, readable: true, lastEventAt: null, settingsPath: '/tmp/claude-settings.json', usage: null },
  deepseek: { connected: false, lastMessageAt: null, releaseUrl: 'https://example.com/releases/latest' },
  paths: { home: '/tmp/dafeiyu', log: '/tmp/dafeiyu/daemon.log' },
}

const CHARACTERS_PAGE_VIEW = {
  current: 'whale',
  preview: { cell: { width: 32, height: 40 }, row: 0, columns: 4, frameMs: 50 },
  list: [
    { id: 'whale', name: '鲸鱼', source: 'builtin' },
    { id: 'cat', name: 'Cat', source: 'codex-pets' },
  ],
}

const okJson = (value) => ({ ok: true, json: async () => value })
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the character sheet animation stops on demand and page unload', () => {
  const page = loadSettingsPage()
  const canvas = page.element('canvas')
  const preview = { cell: { width: 32, height: 40 }, row: 0, columns: 4, frameMs: 50 }

  const stop = page.sandbox.animateSheet(canvas, 'blob:sheet', preview)
  assert.equal(typeof stop, 'function', 'animateSheet returns its stop function')
  assert.equal(page.intervals.size, 0, 'nothing animates before the sheet image loads')

  page.images.at(-1).onload()
  assert.equal(page.intervals.size, 1)
  assert.ok(page.draws.length >= 1, 'the first frame is drawn as soon as the image loads')
  for (const callback of page.intervals.values()) callback()
  assert.ok(page.draws.length >= 2, 'the interval keeps drawing frames')

  stop()
  assert.equal(page.intervals.size, 0, 'stop clears the interval')
  assert.doesNotThrow(() => stop(), 'stopping twice is harmless')

  const stoppedEarly = page.sandbox.animateSheet(canvas, 'blob:sheet-2', preview)
  stoppedEarly()
  page.images.at(-1).onload()
  assert.equal(page.intervals.size, 0, 'a sheet stopped before its image loads never starts')

  page.sandbox.animateSheet(canvas, 'blob:sheet-3', preview)
  page.images.at(-1).onload()
  assert.equal(page.intervals.size, 1)
  page.pageHide()
  assert.equal(page.intervals.size, 0, 'unload clears an animation that is still running')
})

test('the page reuses segmented buttons across refreshes and keeps aria-pressed current', () => {
  const page = loadSettingsPage()
  const el = page.element('span')
  const picks = []

  page.sandbox.renderSegmented(el, [['quiet', '安静'], ['normal', '标准']], 'quiet', (id) => picks.push(['first', id]))
  const buttons = el.children.slice()
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true')

  page.sandbox.renderSegmented(el, [['quiet', '安静'], ['normal', '标准']], 'normal', (id) => picks.push(['second', id]))
  assert.equal(el.children.length, 2)
  assert.equal(el.children[0], buttons[0], 'the same button nodes survive a refresh, so focus is preserved')
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false')
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true')
  buttons[1].click()
  assert.deepEqual(picks, [['second', 'normal']], 'clicks use the latest handler')

  page.sandbox.renderSegmented(el, [['off', '关闭']], 'off', () => {})
  assert.equal(el.children.length, 1, 'a changed option list rebuilds the buttons')
  assert.equal(el.children[0].getAttribute('aria-pressed'), 'true')
})

test('character previews are revoked when the list is rebuilt and when the page unloads', async () => {
  const page = loadSettingsPage({
    hash: '#secret',
    fetchImpl: async (url) => {
      if (url === '/config') return okJson(SETTINGS_PAGE_CONFIG)
      if (url === '/characters') return okJson(CHARACTERS_PAGE_VIEW)
      if (url.startsWith('/characters/preview')) return { ok: true, blob: async () => ({}) }
      if (url === '/bubble-text') return okJson([])
      return { ok: false, status: 404, json: async () => ({}) }
    },
  })
  await settle()
  await settle()
  await settle()

  assert.equal(page.elements.get('characters').children.length, 2, 'both characters render as cards')
  assert.equal(page.createdUrls.length, 2, 'each preview becomes an object URL')
  assert.equal(page.intervals.size, 1, 'only the 5s refresh poll runs while no sheet has loaded')
  assert.equal(page.bodyClasses.add.includes('offline'), false, 'a successful /config keeps the page online')

  page.images.at(-1).onload()
  assert.equal(page.intervals.size, 2, 'the codex sheet animates once its image loads')

  await page.sandbox.renderCharacters()
  await settle()
  await settle()
  await settle()
  assert.equal(page.intervals.size, 1, 'rebuilding the list stops the previous sheet animation')
  assert.deepEqual(page.revoked, page.createdUrls.slice(0, 2), 'rebuilding the list revokes the previous preview URLs')
  assert.equal(page.createdUrls.length, 4, 'the rebuilt cards get fresh object URLs')

  page.pageHide()
  assert.equal(page.intervals.size, 0, 'unload stops the refresh poll')
  assert.deepEqual(page.revoked, page.createdUrls, 'unload revokes every remaining preview URL')
})

test('the page stays online when only /characters fails, and reports offline when /config fails', async () => {
  const partial = loadSettingsPage({
    hash: '#secret',
    fetchImpl: async (url) => {
      if (url === '/config') return okJson(SETTINGS_PAGE_CONFIG)
      if (url === '/characters') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      if (url === '/bubble-text') return okJson([])
      return { ok: false, status: 404, json: async () => ({}) }
    },
  })
  await settle()
  await settle()
  assert.equal(partial.bodyClasses.add.includes('offline'), false, 'a failing /characters does not take the page offline')
  assert.equal(partial.intervals.size, 1, 'the refresh poll keeps running')
  for (const callback of partial.intervals.values()) await callback()

  const offline = loadSettingsPage({ hash: '#secret', fetchImpl: async () => { throw new Error('offline') } })
  await settle()
  await settle()
  assert.ok(offline.bodyClasses.add.includes('offline'), 'a failing /config shows the offline card')
  assert.equal(offline.intervals.size, 1, 'the poll still gets a chance to reconnect')
})
