#!/usr/bin/env node
// Hook entry for every hooks-based product. It must never slow down or break
// the tool that runs it: it forwards a slimmed payload to the pet daemon, starts the daemon when needed,
// prints nothing and always exits 0.
import { callDaemon, ensureDaemon } from '../src/daemon/client.js'
import { eventPayload } from '../src/providers/other/index.js'
import { hookArgument, hookSource, sourceArgument } from '../src/providers/registry.js'

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

// `--event` lets a tool that cannot pass JSON on stdin report an event; stdin
// is then not read at all, so a terminal never waits for input.
async function rawPayload(argv) {
  const event = hookArgument(argv, '--event')
  if (event) return eventPayload(event, { cwd: process.cwd(), sessionId: hookArgument(argv, '--session') })
  return JSON.parse(await readStdin())
}

async function main() {
  const argv = process.argv.slice(2)
  const sourceId = sourceArgument(argv)
  const source = hookSource(sourceId)
  if (!source) return
  const route = `/hooks/${sourceId}`
  let payload
  try {
    payload = source.slim(await rawPayload(argv), { name: hookArgument(argv, '--name') })
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
