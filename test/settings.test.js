import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
