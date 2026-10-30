#!/usr/bin/env node
// Claude Code hook entry. It must never slow down or break Claude Code: it
// forwards a slimmed payload to the pet daemon, starts the daemon when needed,
// prints nothing and always exits 0.
import { callDaemon, ensureDaemon } from '../src/daemon-client.js'
import { hookSource, sourceArgument } from '../src/providers/registry.js'

const MAX_STDIN_BYTES = 4 * 1024 * 1024

async function readStdin() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_STDIN_BYTES) break
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const sourceId = sourceArgument(process.argv.slice(2))
  const source = hookSource(sourceId)
  if (!source) return
  const route = `/hooks/${sourceId}`
  let payload
  try {
    payload = source.slim(JSON.parse(await readStdin()))
  } catch {
    return
  }
  if (!payload?.hook_event_name) return
  try {
    await callDaemon(route, payload)
  } catch (error) {
    if (error?.code === 'HTTP') return
    // Ending a session should not resurrect a pet nobody is watching.
    if (payload.hook_event_name === 'SessionEnd') return
    try {
      await ensureDaemon()
      await callDaemon(route, payload)
    } catch {}
  }
}

main().catch(() => {}).finally(() => process.exit(0))
