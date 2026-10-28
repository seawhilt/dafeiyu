import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bubbleTextView } from './bubble-text.js'
import { CODEX_PREVIEW, codexSheet, installPetdexPet, listCharacters, skinPreview } from './characters.js'
import { claudeIntegrationStatus, installClaudeIntegration, uninstallClaudeIntegration } from './claude-hooks.js'
import { sanitizeSettings } from './daemon-store.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const settingsPagePath = resolve(packageRoot, 'lib', 'settings.html')
const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

// Settings the page may change; everything else stays daemon-owned.
export const EDITABLE_SETTINGS = Object.freeze([
  'scale', 'bubbleScale', 'activityLevel', 'reducedMotion', 'soundEnabled', 'bubbleMode', 'whisperLevel',
])

/** The repository's latest GitHub Release, from package.json. */
export function releaseUrl(repository = pkg.repository?.url ?? '') {
  const match = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/u.exec(repository)
  return match ? `https://github.com/${match[1]}/releases/latest` : 'https://github.com'
}

export class SettingsError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Open a URL in the default browser without blocking the daemon. */
export function openInBrowser(url, { platform = process.platform, run = spawn } = {}) {
  const [command, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]]
  const child = run(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on?.('error', () => {})
  child.unref?.()
}

let whalePreview
/** Preview bytes for a character: a codex sprite sheet, a bundled skin, or the
 * whale's first idle frame. */
export function characterPreview(id, petsRoot) {
  if (id === 'whale') {
    whalePreview ??= readFileSync(resolve(packageRoot, 'assets', 'pet', 'idle', 'idle_001.webp'))
    return whalePreview
  }
  if (id.startsWith('skin:')) return skinPreview(id)
  return codexSheet(id, petsRoot)
}

/** The page with a per-request CSP nonce on its inline style and script. */
export function settingsPage() {
  const nonce = randomBytes(16).toString('base64')
  return {
    html: readFileSync(settingsPagePath, 'utf8').replaceAll('__NONCE__', nonce),
    csp: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src blob:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  }
}

/**
 * Routes behind the right-click "设置…" page. `ctx` exposes the daemon state
 * the page reads and the actions it may take.
 * @param {{
 *   getSettings: () => object,
 *   applySettings: (patch: object) => void,
 *   hub: { state: object },
 *   claudeSettingsPath: string,
 *   paths: { home: string, log: string },
 *   activity: () => { claudeLastEventAt?: number, deepseekLastMessageAt?: number },
 *   claudeUsage: () => object | undefined,
 *   refreshAvailability: () => void,
 *   port: () => number,
 * }} ctx
 */
export function createSettingsRoutes(ctx) {
  const overview = () => {
    const settings = ctx.getSettings()
    const activity = ctx.activity()
    return {
      version: pkg.version,
      pid: process.pid,
      active: ctx.hub.state.active,
      available: ctx.hub.state.available,
      settings: Object.fromEntries(EDITABLE_SETTINGS.map((key) => [key, settings[key]])),
      claude: {
        ...claudeIntegrationStatus(ctx.claudeSettingsPath),
        lastEventAt: activity.claudeLastEventAt ?? null,
        usage: ctx.claudeUsage() ?? null,
      },
      deepseek: {
        connected: settings.deepseekSeen === true,
        lastMessageAt: activity.deepseekLastMessageAt ?? null,
        packageDir: packageRoot,
        packageFile: `${pkg.name}-${pkg.version}.tgz`,
        releaseUrl: releaseUrl(),
      },
      paths: { home: ctx.paths.home, log: ctx.paths.log },
    }
  }

  const characters = () => ({
    current: ctx.character(),
    preview: CODEX_PREVIEW,
    list: listCharacters(ctx.petsRoot),
  })

  return {
    'GET /config': () => overview(),
    'GET /characters': () => characters(),
    'POST /character': async (body) => {
      if (typeof body?.id !== 'string' || !listCharacters(ctx.petsRoot).some((item) => item.id === body.id)) {
        throw new SettingsError(404, '没有这个形象')
      }
      const current = ctx.character()
      if (!(await ctx.setCharacter(body.id)) && body.id !== current) {
        throw new SettingsError(409, '这个形象无法加载，请重新安装或换一个')
      }
      return characters()
    },
    'POST /characters/install': async (body) => {
      let id
      try {
        id = await installPetdexPet(body?.name, { root: ctx.petsRoot, fetchImpl: ctx.fetchImpl })
      } catch (error) {
        throw new SettingsError(error.code === 'BAD_NAME' ? 400 : error.code === 'NOT_FOUND' ? 404 : 502, error.message)
      }
      return { ...characters(), installed: id }
    },
    'GET /bubble-text': () => bubbleTextView(ctx.bubbleText()),
    'POST /bubble-text': (body) => {
      if (!body?.groups || typeof body.groups !== 'object' || Array.isArray(body.groups)) {
        throw new SettingsError(400, 'groups must be an object')
      }
      return bubbleTextView(ctx.setBubbleText(body.groups))
    },
    'POST /config': (body) => {
      const patch = body?.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError(400, 'patch must be an object')
      const unknown = Object.keys(patch).filter((key) => !EDITABLE_SETTINGS.includes(key))
      if (unknown.length > 0) throw new SettingsError(400, `unknown setting: ${unknown.join(', ')}`)
      // sanitizeSettings clamps ranges and rejects bad values to the defaults;
      // only the keys the page sent are taken from it.
      const clean = sanitizeSettings({ ...ctx.getSettings(), ...patch })
      ctx.applySettings(Object.fromEntries(Object.keys(patch).map((key) => [key, clean[key]])))
      return overview()
    },
    'POST /claude/install': () => {
      try {
        installClaudeIntegration(ctx.claudeSettingsPath, ctx.paths)
      } catch (error) {
        throw new SettingsError(409, `无法写入 Claude 设置：${error.message}`)
      }
      ctx.refreshAvailability()
      return overview()
    },
    'POST /claude/uninstall': () => {
      try {
        uninstallClaudeIntegration(ctx.claudeSettingsPath, ctx.paths)
      } catch (error) {
        throw new SettingsError(409, `无法修改 Claude 设置：${error.message}`)
      }
      ctx.refreshAvailability()
      return overview()
    },
  }
}
