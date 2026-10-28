import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { daemonPaths } from '../src/daemon-store.js'
import {
  HOOK_EVENTS,
  installClaudeIntegration,
  uninstallClaudeIntegration,
  claudeHooksInstalled,
  hasDafeiyuHooks,
  installClaudeHooks,
  uninstallClaudeHooks,
  withDafeiyuHooks,
  withoutDafeiyuHooks,
} from '../src/claude-hooks.js'

const command = '"/usr/bin/node" "/x/bin/dafeiyu-hook.mjs"'
const foreign = { hooks: [{ type: 'command', command: 'other.sh' }] }

test('install adds every event and keeps foreign hooks', () => {
  const next = withDafeiyuHooks({ model: 'x', hooks: { Stop: [foreign] } }, command)
  assert.equal(next.model, 'x')
  for (const event of HOOK_EVENTS) assert.ok(next.hooks[event].some((group) => group.hooks[0].command === command), event)
  assert.deepEqual(next.hooks.Stop[0], foreign)
  assert.ok(hasDafeiyuHooks(next))
})

test('install is idempotent and uninstall restores the original hooks', () => {
  const once = withDafeiyuHooks({ hooks: { Stop: [foreign] } }, command)
  const twice = withDafeiyuHooks(once, command)
  assert.equal(twice.hooks.Stop.length, 2)
  const removed = withoutDafeiyuHooks(twice)
  assert.deepEqual(removed.hooks, { Stop: [foreign] })
  assert.equal(hasDafeiyuHooks(removed), false)
})

test('file round trip writes a backup and refuses to clobber invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-hooks-'))
  try {
    const path = join(dir, 'settings.json')
    assert.equal(claudeHooksInstalled(path), false)
    writeFileSync(path, JSON.stringify({ theme: 'dark' }))
    installClaudeHooks(path, command)
    assert.equal(claudeHooksInstalled(path), true)
    assert.ok(existsSync(`${path}.dafeiyu.bak`))
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).theme, 'dark')
    assert.equal(uninstallClaudeHooks(path), true)
    assert.equal(uninstallClaudeHooks(path), false)
    assert.equal(claudeHooksInstalled(path), false)

    writeFileSync(path, '{ broken')
    assert.throws(() => installClaudeHooks(path, command))
    assert.equal(readFileSync(path, 'utf8'), '{ broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installing restores a status line wrapped by an earlier build and keeps other settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-statusline-'))
  try {
    const path = join(dir, 'settings.json')
    const paths = daemonPaths(join(dir, 'home'))
    const original = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 }
    mkdirSync(paths.home, { recursive: true })
    writeFileSync(join(paths.home, 'statusline.json'), JSON.stringify({ statusLine: original }))
    writeFileSync(path, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: '"node" "/x/bin/dafeiyu-statusline.mjs"' } }))
    installClaudeIntegration(path, paths)
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(installed.statusLine, original)
    assert.equal(installed.theme, 'dark')
    assert.ok(hasDafeiyuHooks(installed))
    assert.equal(existsSync(join(paths.home, 'statusline.json')), false, 'the saved copy is no longer needed')
    assert.equal(uninstallClaudeIntegration(path, paths), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'dark', statusLine: original, hooks: {} })
    assert.equal(uninstallClaudeIntegration(path, paths), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
