import assert from 'node:assert/strict'
import test from 'node:test'
import { slimClaudeHookPayload, translateClaudeHook } from '../src/providers/claude/adapter.js'
import { isProviderId } from '../src/provider-hub.js'
import { HOOK_SOURCE_IDS, hookSource, sourceArgument } from '../src/providers/registry.js'

test('Claude is registered as a hook source with its own translate and slim', () => {
  assert.deepEqual(HOOK_SOURCE_IDS, ['claude'])
  const claude = hookSource('claude')
  assert.equal(claude.label, 'Claude')
  assert.equal(claude.translate, translateClaudeHook)
  assert.equal(claude.slim, slimClaudeHookPayload)
  assert.match(claude.integration.settingsPath(), /settings\.json$/u)
  assert.equal(typeof claude.usage.query, 'function')
})

test('unknown or inherited names are not hook sources', () => {
  assert.equal(hookSource('codex'), undefined)
  assert.equal(hookSource('toString'), undefined)
  assert.equal(hookSource(undefined), undefined)
})

test('the hook script requires an explicit source', () => {
  assert.equal(sourceArgument([]), undefined)
  assert.equal(sourceArgument(['--source']), undefined)
  assert.equal(sourceArgument(['--source', 'claude']), 'claude')
})

test('every hook source has a provider hub channel, or its events would be dropped', () => {
  for (const id of HOOK_SOURCE_IDS) assert.ok(isProviderId(id), `${id} is missing from PROVIDERS`)
})
