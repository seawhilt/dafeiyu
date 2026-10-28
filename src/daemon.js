import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { translateClaudeHook } from './claude-adapter.js'
import { claudeHooksInstalled, claudeSettingsPath as defaultClaudeSettingsPath } from './claude-hooks.js'
import { queryClaudeUsage, usageMessage } from './claude-usage.js'
import { CompanionReducer } from './companion-reducer.js'
import { HelperProcess } from './helper-process.js'
import { createDaemonServer, HttpError } from './daemon-server.js'
import { assertCompanionMessage, CompanionMessageKind, createMessage } from './protocol.js'
import { isProviderId, ProviderHub } from './provider-hub.js'
import { applyBubbleText, sanitizeBubbleText, takeLegacyBubbleText } from './bubble-text.js'
import { codexPetsRoot } from './characters.js'
import { createPetDirector } from './pet-director.js'
import { createPetWindow } from './pet-window.js'
import { characterPreview, createSettingsRoutes, openInBrowser, settingsPage } from './settings-routes.js'
import { createUsagePoller, USAGE_AFTER_TURN_MS, USAGE_POLL_MS } from './usage-poller.js'
import { loadWhisperLines, WhisperScheduler } from './whisper.js'
import {
  daemonPaths,
  loadSettings,
  readRuntime,
  saveSettings,
  writeRuntime,
} from './daemon-store.js'

const MAX_MESSAGES_PER_POST = 64
const AVAILABILITY_POLL_MS = 10000
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
 *   isClaudeConfigured?: () => boolean,
 *   claudeSettingsPath?: string,
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
  claudeSettingsPath = defaultClaudeSettingsPath(),
  isClaudeConfigured = () => claudeHooksInstalled(claudeSettingsPath),
  openUrl = openInBrowser,
  queryUsage = () => queryClaudeUsage(),
  usageTimings = { pollMs: USAGE_POLL_MS, afterTurnMs: USAGE_AFTER_TURN_MS },
  petsRoot = codexPetsRoot(),
  fetchImpl = fetch,
  onExit = () => {},
} = {}) {
  let settings = loadSettings(paths)
  let claudeSeen = false
  let closed = false
  const activity = {}

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
  const legacyBubbleText = takeLegacyBubbleText(paths.home)
  if (legacyBubbleText) persist({ bubbleText: legacyBubbleText })
  const whisperLines = () => (settings.bubbleText.chatter
    ? { ...loadWhisperLines(paths.home), generic: settings.bubbleText.chatter }
    : loadWhisperLines(paths.home))

  function onSettingsChange(report) {
      const patch = {}
      if (Number.isFinite(report.scale)) patch.scale = report.scale
      if (Number.isFinite(report.bubbleScale)) patch.bubbleScale = report.bubbleScale
      if (typeof report.reducedMotion === 'boolean') patch.reducedMotion = report.reducedMotion
      if (isProviderId(report.provider) && hub.select(report.provider)) patch.provider = report.provider
      if (['off', 'low', 'high'].includes(report.whisperLevel)) {
        patch.whisperLevel = report.whisperLevel
        whisper.setLevel(report.whisperLevel)
      }
      if (report.request === 'whisper') whisper.speak()
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
    activeProvider: () => hub.active,
    usage: () => (hub.active === 'claude' ? claudeUsage : undefined),
  })
  hub = new ProviderHub({
    send: (message) => {
      whisper.observe(message)
      toPet(applyBubbleText(message, settings.bubbleText))
    },
    displaySettings: () => ({ ...displaySettingsOf(settings), characters: helper.characters(), character: settings.character }),
    preferred: settings.provider,
  })
  const claudeReducer = new CompanionReducer({ includeSubagents: settings.includeSubagents, hostLabel: 'Claude' })
  let seq = 0

  const refreshAvailability = () => {
    const available = []
    if (claudeSeen || isClaudeConfigured()) available.push('claude')
    if (settings.deepseekSeen) available.push('deepseek')
    hub.setAvailable(available)
  }

  const usagePoller = createUsagePoller({
    query: queryUsage,
    enabled: () => !closed && hub.state.available.includes('claude'),
    onUsage(usage) {
      if (hub.active === 'claude') whisper.alertQuota(claudeUsage, usage)
      claudeUsage = usage
      hub.receive('claude', usageMessage(usage))
    },
    timings: usageTimings,
    logger,
  })

  const handleClaudeHook = (payload) => {
    activity.claudeLastEventAt = Date.now()
    if (payload?.hook_event_name === 'Stop') usagePoller.afterTurn()
    if (!claudeSeen) {
      claudeSeen = true
      refreshAvailability()
    }
    for (const item of translateClaudeHook(payload, ++seq)) {
      const messages = item.type === 'dispose'
        ? claudeReducer.disposeSession(item.session)
        : claudeReducer.handle(item.session, item.event)
      for (const message of messages) hub.receive('claude', message)
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
    if (provider === 'deepseek') activity.deepseekLastMessageAt = Date.now()
    if (provider === 'deepseek' && body.register === true && !settings.deepseekSeen) {
      persist({ deepseekSeen: true })
      refreshAvailability()
    }
    for (const message of messages) hub.receive(provider, message)
  }

  const status = () => ({ pid: process.pid, ...hub.state })

  // Display settings changed from the settings page take effect at once.
  const applySettings = (patch) => {
    persist(patch)
    if (patch.whisperLevel) whisper.setLevel(patch.whisperLevel)
    hub.refreshConfig()
  }

  const routes = {
    'GET /status': () => status(),
    'POST /claude/hook': (body) => {
      handleClaudeHook(body)
      return { ok: true }
    },
    'POST /providers/*': (body, url) => {
      const provider = /^\/providers\/([a-z]+)\/messages$/u.exec(url.pathname)?.[1]
      if (!isProviderId(provider)) throw new HttpError(404, 'unknown provider')
      handleProviderMessages(provider, body)
      return { ok: true }
    },
    'POST /provider': (body) => {
      if (!isProviderId(body.provider)) throw new HttpError(400, 'unknown provider')
      if (!hub.select(body.provider)) throw new HttpError(409, `${body.provider} is not configured`)
      persist({ provider: body.provider })
      return status()
    },
    'POST /forget': (body) => {
      if (body.provider !== 'deepseek') throw new HttpError(400, 'only deepseek can be forgotten; remove Claude hooks instead')
      persist({ deepseekSeen: false })
      hub.resetProvider('deepseek')
      refreshAvailability()
      return status()
    },
    ...createSettingsRoutes({
      getSettings: () => settings,
      applySettings,
      hub,
      claudeSettingsPath,
      paths,
      activity: () => ({ ...activity }),
      claudeUsage: () => claudeUsage,
      refreshAvailability,
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
        return { contentType: id.startsWith('skin:') ? 'image/png' : 'image/webp', bytes }
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
  logger.info?.(`dafeiyu daemon listening on 127.0.0.1:${port}`)

  async function close(reason = 'shutdown') {
    if (closed) return
    closed = true
    clearInterval(availabilityTimer)
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
