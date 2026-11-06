import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { queryClaudeUsage, usageMessage } from '../providers/claude/usage.js'
import { CompanionReducer } from '../core/companion-reducer.js'
import { HelperProcess } from '../pet/helper-process.js'
import { createDaemonServer, HttpError } from './server.js'
import { assertCompanionMessage, CompanionMessageKind, createMessage } from '../core/protocol.js'
import { isProviderId, normalizeOrder, PROVIDER_IDS, PROVIDERS, ProviderHub } from '../hub/provider-hub.js'
import { applyBubbleText, sanitizeBubbleText } from '../core/bubble-text.js'
import { codexPetsRoot, isSkin } from '../pet/characters.js'
import { createPetDirector } from '../pet/pet-director.js'
import { createPetWindow } from '../pet/pet-window.js'
import { characterPreview, createSettingsRoutes, openInBrowser, settingsPage } from './settings-routes.js'
import { HOOK_SOURCE_IDS, hookSource } from '../providers/registry.js'
import { otherHookCommand } from '../providers/other/index.js'
import { createUsagePoller, USAGE_AFTER_TURN_MS, USAGE_POLL_MS } from './usage-poller.js'
import { loadWhisperLines, WhisperScheduler } from '../core/whisper.js'
import {
  daemonPaths,
  loadSettings,
  readRuntime,
  saveSettings,
  writeRuntime,
} from './store.js'

const MAX_MESSAGES_PER_POST = 64
const AVAILABILITY_POLL_MS = 10000
const SESSION_SWEEP_MS = 60000
const CLOSE_GRACE_MS = 500

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Single-instance guard. A lock left behind by a dead process is reclaimed.
 * @returns {boolean} true when this process now owns the lock
 */
export function acquireLock(paths) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(paths.lock, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let ownerText
      let owner
      try {
        ownerText = readFileSync(paths.lock, 'utf8')
        owner = Number(ownerText)
      } catch {}
      if (!Number.isInteger(owner) || owner <= 0) {
        // An empty lock belongs to a starter between create and write. It is
        // only reclaimable once it is clearly abandoned (a crash in that
        // window), never while a concurrent starter may still be writing.
        let modifiedAt
        try { modifiedAt = statSync(paths.lock).mtimeMs } catch {}
        if (modifiedAt === undefined || Date.now() - modifiedAt < 1000) return false
        try { rmSync(paths.lock, { force: true }) } catch {}
        continue
      }
      if (processAlive(owner)) return false
      // Reclaim only a lock that is unchanged since the read: another starter
      // may have replaced the stale file in between.
      try {
        if (readFileSync(paths.lock, 'utf8') !== ownerText) continue
      } catch {
        continue
      }
      try { rmSync(paths.lock, { force: true }) } catch {}
    }
  }
  return false
}

function displaySettingsOf(settings) {
  return {
    scale: settings.scale,
    bubbleScale: settings.bubbleScale,
    activityLevel: settings.activityLevel,
    reducedMotion: settings.reducedMotion,
    soundEnabled: settings.soundEnabled,
    bubbleMode: settings.bubbleMode,
    bubbleStates: settings.bubbleStates,
    whisperLevel: settings.whisperLevel,
  }
}

function helperEnvironment(settings) {
  return {
    DAFEIYU_SCALE: String(settings.scale),
    DAFEIYU_BUBBLE_SCALE: String(settings.bubbleScale),
    DAFEIYU_ACTIVITY_LEVEL: settings.activityLevel,
    DAFEIYU_REDUCED_MOTION: settings.reducedMotion ? '1' : '0',
    DAFEIYU_SOUND_ENABLED: settings.soundEnabled ? '1' : '0',
    DAFEIYU_BUBBLE_MODE: settings.bubbleMode,
    DAFEIYU_BUBBLE_STATES: settings.bubbleStates.join(','),
    DAFEIYU_WEBUI_URL: '',
    DAFEIYU_OPEN_LABEL: '',
  }
}

/**
 * Owns the pet window and routes every provider's updates through one hub.
 * @param {{
 *   paths?: ReturnType<typeof daemonPaths>,
 *   logger?: Console,
 *   createHelper?: (options: object) => { start(): void, send(message: object): void, stop(reason?: string): void },
 *   sourcePaths?: Record<string, string>,
 *   openUrl?: (url: string) => void,
 *   queryUsage?: () => Promise<object>,
 *   usageTimings?: { pollMs: number, afterTurnMs: number },
 *   petsRoot?: string,
 *   fetchImpl?: typeof fetch,
 *   onExit?: () => void,
 * }} [options]
 */
export async function startDaemon({
  paths = daemonPaths(),
  logger = console,
  createHelper = (options) => new HelperProcess(options, logger),
  sourcePaths = {},
  openUrl = openInBrowser,
  queryUsage = () => queryClaudeUsage(),
  usageTimings = { pollMs: USAGE_POLL_MS, afterTurnMs: USAGE_AFTER_TURN_MS },
  petsRoot = codexPetsRoot(),
  fetchImpl = fetch,
  onExit = () => {},
} = {}) {
  let settings = loadSettings(paths)
  let closed = false
  // Sources that reached the daemon this run, and when they last did.
  const seen = new Set()
  const lastEventAt = {}

  const persist = (patch) => {
    try {
      settings = saveSettings(paths, { ...settings, ...patch })
    } catch (error) {
      logger.warn?.(`dafeiyu could not save settings: ${error.message}`)
      settings = { ...settings, ...patch }
    }
  }

  let hub
  let whisper
  let claudeUsage
  const whisperLines = () => (settings.bubbleText.chatter
    ? { ...loadWhisperLines(paths.home), generic: settings.bubbleText.chatter }
    : loadWhisperLines(paths.home))

  function onSettingsChange(report) {
      const patch = {}
      if (Number.isFinite(report.scale)) patch.scale = report.scale
      if (Number.isFinite(report.bubbleScale)) patch.bubbleScale = report.bubbleScale
      if (typeof report.reducedMotion === 'boolean') patch.reducedMotion = report.reducedMotion
      if (['off', 'low', 'high'].includes(report.whisperLevel)) {
        patch.whisperLevel = report.whisperLevel
        whisper.setLevel(report.whisperLevel)
      }
      if (report.request === 'whisper') whisper.speak()
      if (report.request === 'dismiss-errors') dismissErrors()
      if (report.request === 'settings') openSettings()
      if (typeof report.character === 'string') {
        void setCharacter(report.character).catch((error) => {
          logger.warn?.(`dafeiyu could not switch character: ${error.message}`)
        })
      }
      if (Object.keys(patch).length > 0) persist(patch)
  }
  const helper = createPetWindow({
    createHelper,
    environment: () => helperEnvironment(settings),
    character: () => settings.character,
    home: paths.home,
    petsRoot,
    onSettingsChange,
    onInput: (report) => director.input(report),
    onPass: (report) => director.passEnded(report.clip),
    onClosed(report) {
      // Character changes shut down the old helper with reason="host" before
      // starting its replacement. Only an explicit user close should stop the
      // shared daemon; treating host shutdowns as user intent made skin changes
      // close the newly started helper a few hundred milliseconds later.
      if (report?.reason !== 'user') return
      // "本次关闭" ends this run; the next hook or DSH start brings it back.
      setTimeout(() => void close('user-closed'), CLOSE_GRACE_MS).unref?.()
    },
    logger,
  })

  // Switching character restarts the pet window with the new frames, then
  // replays the current state onto it.
  async function setCharacter(id) {
    if (id === settings.character || !helper.hasCharacter(id)) return false
    // Prepare the new assets before persisting the choice: a broken pack must
    // leave the previous character selected and selectable, not strand the
    // user on a fallback.
    if (!helper.canLoad(id)) return false
    persist({ character: id })
    const restarting = helper.restart()
    director.setManifest(helper.manifest())
    hub.replay()
    try {
      await restarting
    } catch (error) {
      logger.warn?.(`dafeiyu could not switch character: ${error.message}`)
      return false
    }
    return true
  }
  // Decides every animation; the helper only renders what it is told.
  const director = createPetDirector({ manifest: helper.manifest(), send: (message) => helper.send(message) })
  const toPet = (message) => {
    director.observe(message)
    helper.send(message)
  }
  whisper = new WhisperScheduler({
    level: settings.whisperLevel,
    lines: whisperLines(),
    say: toPet,
    activeProvider: () => hub.displayed,
    usage: () => (hub.displayed === 'claude' ? claudeUsage : undefined),
  })
  hub = new ProviderHub({
    send: (message) => {
      whisper.observe(message)
      toPet(applyBubbleText(message, settings.bubbleText))
    },
    displaySettings: () => ({ ...displaySettingsOf(settings), characters: helper.characters(), character: settings.character }),
    order: settings.sources.order,
  })
  // One reducer per hook source: each product keeps its own sessions.
  const reducers = new Map(HOOK_SOURCE_IDS.map((id) => [
    id,
    new CompanionReducer({ includeSubagents: settings.includeSubagents, hostLabel: hookSource(id).label }),
  ]))
  const sendFromSource = (sourceId, messages) => {
    for (const message of messages) hub.receive(sourceId, message)
  }
  let seq = 0

  const integrationStatus = (id) => {
    const source = hookSource(id)
    return source?.integration?.status(sourcePaths[id])
  }
  // Set up: hooks are installed (or events arrive anyway), or DSH registered.
  const isConfigured = (id) => seen.has(id)
    || (id === 'deepseek' ? settings.deepseekSeen : integrationStatus(id)?.installed === true)
  const isEnabled = (id) => !settings.sources.disabled.includes(id)

  const refreshAvailability = () => {
    hub.setAvailable(PROVIDER_IDS.filter((id) => isConfigured(id) && isEnabled(id)))
  }

  function dismissErrors() {
    for (const [sourceId, reducer] of reducers) sendFromSource(sourceId, reducer.dismissErrors())
    hub.dismissErrors()
  }

  const usagePoller = createUsagePoller({
    query: queryUsage,
    enabled: () => !closed && hub.state.available.includes('claude'),
    onUsage(usage) {
      if (hub.displayed === 'claude') whisper.alertQuota(claudeUsage, usage)
      claudeUsage = usage
      hub.receive('claude', usageMessage(usage))
    },
    timings: usageTimings,
    logger,
  })

  const handleHook = (sourceId, payload) => {
    const source = hookSource(sourceId)
    if (!source) throw new HttpError(404, 'unknown hook source')
    lastEventAt[sourceId] = Date.now()
    if (sourceId === 'claude' && payload?.hook_event_name === 'Stop') usagePoller.afterTurn()
    if (!seen.has(sourceId)) {
      seen.add(sourceId)
      refreshAvailability()
    }
    const reducer = reducers.get(sourceId)
    for (const item of source.translate(payload, ++seq)) {
      sendFromSource(sourceId, item.type === 'dispose'
        ? reducer.disposeSession(item.session)
        : reducer.handle(item.session, item.event))
    }
  }

  const handleProviderMessages = (provider, body) => {
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, MAX_MESSAGES_PER_POST) : []
    for (const message of messages) {
      try {
        assertCompanionMessage(message)
      } catch (error) {
        throw new HttpError(400, error.message)
      }
    }
    lastEventAt[provider] = Date.now()
    if (provider === 'deepseek' && body.register === true && !settings.deepseekSeen) {
      persist({ deepseekSeen: true })
      refreshAvailability()
    }
    for (const message of messages) hub.receive(provider, message)
  }

  const status = () => ({ pid: process.pid, ...hub.state })
  // hooks: dafeiyu writes them; manual: the user adds our command to the tool.
  const kindOf = (id) => {
    const source = hookSource(id)
    if (!source) return 'dsh'
    return source.integration ? 'hooks' : 'manual'
  }

  // What the settings page lists and changes, one row per source in the
  // user's order.
  const sources = {
    list: () => hub.state.order.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      kind: kindOf(id),
      enabled: isEnabled(id),
      configured: isConfigured(id),
      displayed: hub.displayed === id,
      lastEventAt: lastEventAt[id] ?? null,
      integration: integrationStatus(id) ?? null,
      setupNote: hookSource(id)?.setupNote ?? null,
      command: id === 'other' ? otherHookCommand('gemini') : null,
      usage: id === 'claude' ? claudeUsage ?? null : null,
    })),
    setOrder(order) {
      persist({ sources: { ...settings.sources, order: normalizeOrder(order) } })
      hub.setOrder(settings.sources.order)
    },
    setEnabled(id, enabled) {
      const others = settings.sources.disabled.filter((item) => item !== id)
      persist({ sources: { ...settings.sources, disabled: enabled ? others : [...others, id] } })
      refreshAvailability()
    },
    install(id) {
      hookSource(id).integration.install(sourcePaths[id])
      refreshAvailability()
    },
    uninstall(id) {
      const removed = hookSource(id).integration.uninstall(sourcePaths[id])
      // Sessions already running keep their old hooks until they end.
      seen.delete(id)
      refreshAvailability()
      return removed
    },
  }

  // Display settings changed from the settings page take effect at once.
  const applySettings = (patch) => {
    persist(patch)
    if (patch.whisperLevel) whisper.setLevel(patch.whisperLevel)
    hub.refreshConfig()
  }

  const routes = {
    'GET /status': () => status(),
    'POST /hooks/*': (body, url) => {
      const sourceId = /^\/hooks\/([a-z0-9-]+)$/u.exec(url.pathname)?.[1]
      handleHook(sourceId, body)
      return { ok: true }
    },
    'POST /providers/*': (body, url) => {
      const provider = /^\/providers\/([a-z]+)\/messages$/u.exec(url.pathname)?.[1]
      if (!isProviderId(provider)) throw new HttpError(404, 'unknown provider')
      handleProviderMessages(provider, body)
      return { ok: true }
    },
    ...createSettingsRoutes({
      getSettings: () => settings,
      applySettings,
      hub,
      sources,
      paths,
      port: () => port,
      petsRoot,
      fetchImpl,
      character: () => settings.character,
      setCharacter,
      bubbleText: () => settings.bubbleText,
      setBubbleText(value) {
        persist({ bubbleText: sanitizeBubbleText(value) })
        whisper.lines = whisperLines()
        return settings.bubbleText
      },
    }),
    'POST /settings/open': () => {
      openSettings()
      return { ok: true }
    },
    'POST /shutdown': () => {
      setImmediate(() => void close('cli-stop'))
      return { ok: true }
    },
  }

  const token = randomBytes(24).toString('hex')
  let port
  // The token travels in the URL fragment, which browsers never send to the
  // server; the page reads it and uses it as a header like the CLI does.
  const settingsUrl = () => `http://127.0.0.1:${port}/settings#${token}`
  function openSettings() {
    try {
      openUrl(settingsUrl())
    } catch (error) {
      logger.warn?.(`dafeiyu could not open the settings page: ${error.message}`)
    }
  }
  const server = createDaemonServer({
    token,
    routes,
    page: settingsPage,
    binary: {
      'GET /characters/preview': (url) => {
        const id = url.searchParams.get('id') ?? ''
        if (!helper.hasCharacter(id)) throw new HttpError(404, 'unknown character')
        const bytes = characterPreview(id, petsRoot)
        if (!bytes) throw new HttpError(404, 'no preview')
        return { contentType: isSkin(id) ? 'image/png' : 'image/webp', bytes }
      },
    },
    logger,
  })
  port = await server.listen()
  writeRuntime(paths, { pid: process.pid, port, token })

  helper.start()
  helper.send(createMessage(CompanionMessageKind.HELLO, { host: 'dafeiyu-daemon', message: 'Pet daemon started' }))
  refreshAvailability()
  hub.replay()
  whisper.start()
  usagePoller.start()
  const availabilityTimer = setInterval(refreshAvailability, AVAILABILITY_POLL_MS)
  availabilityTimer.unref?.()
  const sweepTimer = setInterval(() => {
    for (const [sourceId, reducer] of reducers) sendFromSource(sourceId, reducer.sweep())
  }, SESSION_SWEEP_MS)
  sweepTimer.unref?.()
  logger.info?.(`dafeiyu daemon listening on 127.0.0.1:${port}`)

  async function close(reason = 'shutdown') {
    if (closed) return
    closed = true
    clearInterval(availabilityTimer)
    clearInterval(sweepTimer)
    usagePoller.stop()
    whisper.stop()
    director.stop()
    helper.stop(reason)
    try {
      await server.close()
    } finally {
      if (readRuntime(paths)?.pid === process.pid) rmSync(paths.runtime, { force: true })
      rmSync(paths.lock, { force: true })
      onExit(reason)
    }
  }

  return { port, hub, whisper, close, status, settingsUrl }
}
