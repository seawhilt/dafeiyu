import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createJsonHooksIntegration,
  hasDafeiyuHooks,
  hookCommand,
  withDafeiyuHooks,
  withoutDafeiyuHooks,
} from '../../src/providers/json-hooks.js'

const events = ['Stop', 'PreToolUse']
const command = '"/usr/bin/node" "/x/bin/dafeiyu-hook.mjs" --source demo'
const foreign = { hooks: [{ type: 'command', command: 'other.sh' }] }

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-hooks-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the hook command names its source', () => {
  assert.equal(hookCommand('claude', '/n', '/s.mjs'), '"/n" "/s.mjs" --source claude')
})

test('install adds every event and keeps foreign hooks', () => {
  const next = withDafeiyuHooks({ model: 'x', hooks: { Stop: [foreign] } }, events, command)
  assert.equal(next.model, 'x')
  for (const event of events) assert.ok(next.hooks[event].some((group) => group.hooks[0].command === command), event)
  assert.deepEqual(next.hooks.Stop[0], foreign)
  assert.ok(hasDafeiyuHooks(next))
})

test('install is idempotent and uninstall restores the original hooks', () => {
  const once = withDafeiyuHooks({ hooks: { Stop: [foreign] } }, events, command)
  const twice = withDafeiyuHooks(once, events, command)
  assert.equal(twice.hooks.Stop.length, 2)
  const removed = withoutDafeiyuHooks(twice)
  assert.deepEqual(removed.hooks, { Stop: [foreign] })
  assert.equal(hasDafeiyuHooks(removed), false)
})

test('file round trip writes a backup and refuses to clobber invalid JSON', () => withTempDir((dir) => {
  const path = join(dir, 'settings.json')
  const integration = createJsonHooksIntegration({ source: 'demo', events, settingsPath: () => path })
  assert.equal(integration.status().installed, false)
  writeFileSync(path, JSON.stringify({ theme: 'dark' }))
  integration.install(path, command)
  assert.equal(integration.status().installed, true)
  assert.ok(existsSync(`${path}.dafeiyu.bak`))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).theme, 'dark')
  assert.equal(integration.uninstall(), true)
  assert.equal(integration.uninstall(), false)
  assert.equal(integration.status().installed, false)

  writeFileSync(path, '{ broken')
  assert.throws(() => integration.install(path, command))
  assert.equal(readFileSync(path, 'utf8'), '{ broken')
  assert.equal(integration.status().readable, false)
}))

test('installing preserves the settings file mode and does not widen it', { skip: process.platform === 'win32' }, () => withTempDir((dir) => {
  const path = join(dir, 'settings.json')
  const integration = createJsonHooksIntegration({ source: 'demo', events, settingsPath: () => path })
  writeFileSync(path, JSON.stringify({ theme: 'dark' }), { mode: 0o600 })
  chmodSync(path, 0o600)
  integration.install(path, command)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(`${path}.dafeiyu.bak`).mode & 0o777, 0o600)

  const fresh = join(dir, 'fresh', 'settings.json')
  integration.install(fresh, command)
  assert.equal(statSync(fresh).mode & 0o777, 0o600)
}))

test('flat layout writes bare command entries and keeps the required top-level fields', () => {
  const options = { layout: 'flat', timeout: 3 }
  const next = withDafeiyuHooks({ hooks: { stop: [{ command: 'audit.sh' }] } }, ['stop', 'sessionEnd'], command, options)
  assert.deepEqual(next.hooks.stop, [{ command: 'audit.sh' }, { command, timeout: 3 }])
  assert.deepEqual(next.hooks.sessionEnd, [{ command, timeout: 3 }])
  assert.ok(hasDafeiyuHooks(next))
  assert.deepEqual(withoutDafeiyuHooks(next).hooks, { stop: [{ command: 'audit.sh' }] })
})

test('an integration can require top-level fields such as a schema version', () => withTempDir((dir) => {
  const path = join(dir, 'hooks.json')
  const integration = createJsonHooksIntegration({
    source: 'demo', events, settingsPath: () => path, layout: 'flat', defaults: { version: 1 },
  })
  integration.install(path, command)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.version, 1)
  assert.deepEqual(written.hooks.Stop, [{ command, timeout: 5 }])
}))
