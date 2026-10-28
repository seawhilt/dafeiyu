#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import {
  claudeHooksInstalled,
  claudeSettingsPath,
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from '../src/claude-hooks.js'
import { acquireLock, startDaemon } from '../src/daemon.js'
import { callDaemon, ensureDaemon } from '../src/daemon-client.js'
import { daemonPaths } from '../src/daemon-store.js'
import { PROVIDER_IDS } from '../src/provider-hub.js'

const USAGE = `用法: dafeiyu <命令>

  start                 后台启动桌宠守护进程
  stop                  关闭守护进程
  status                查看当前服务商和已配置的服务商
  settings              打开设置页（也可在桌宠右键菜单选择「设置…」）
  use <claude|deepseek> 切换服务商（也可在桌宠右键菜单切换）
  install-claude        在 ${claudeSettingsPath()} 写入 Claude Code hooks
  uninstall-claude      移除 Claude Code hooks
  forget-deepseek       不再把 DeepSeek（DSH）列为可选服务商
  daemon                前台运行守护进程（调试用）`

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function fileLogger(path) {
  const write = (level, args) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${args.map((item) => (item instanceof Error ? item.stack : String(item))).join(' ')}\n`)
    } catch {}
  }
  return {
    debug: () => {},
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  }
}

async function runDaemon() {
  const paths = daemonPaths()
  mkdirSync(paths.home, { recursive: true })
  if (!acquireLock(paths)) return
  const logger = fileLogger(paths.log)
  const daemon = await startDaemon({ paths, logger, onExit: () => process.exit(0) })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void daemon.close(signal))
}

function describe(status) {
  const labels = { claude: 'Claude', deepseek: 'DeepSeek' }
  const available = status.available.map((id) => labels[id]).join('、') || '无'
  return `当前服务商: ${status.active ? labels[status.active] : '未配置'}\n已配置: ${available}`
}

async function main(command, args) {
  switch (command) {
    case 'daemon':
      return runDaemon()
    case 'start':
      return print(describe(await ensureDaemon()))
    case 'stop':
      try {
        await callDaemon('/shutdown', {})
        return print('已关闭')
      } catch {
        return print('守护进程未运行')
      }
    case 'status':
      try {
        return print(describe(await callDaemon('/status')))
      } catch {
        return print(`守护进程未运行\nClaude hooks: ${claudeHooksInstalled() ? '已安装' : '未安装'}`)
      }
    case 'settings':
      await ensureDaemon()
      await callDaemon('/settings/open', {})
      return print('已在浏览器打开设置页')
    case 'use': {
      const provider = args[0]
      if (!PROVIDER_IDS.includes(provider)) return fail(`服务商只能是 ${PROVIDER_IDS.join(' / ')}`)
      await ensureDaemon()
      return print(describe(await callDaemon('/provider', { provider })))
    }
    case 'install-claude':
      installClaudeIntegration()
      return print('已写入 Claude Code hooks（原文件备份为 settings.json.dafeiyu.bak）。新开的 Claude Code 会话生效。')
    case 'uninstall-claude':
      return print(uninstallClaudeIntegration() ? '已移除 Claude Code hooks' : '没有找到 dafeiyu 的配置')
    case 'forget-deepseek':
      await ensureDaemon()
      return print(describe(await callDaemon('/forget', { provider: 'deepseek' })))
    default:
      print(USAGE)
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1
  }
}

main(process.argv[2], process.argv.slice(3)).catch((error) => fail(error instanceof Error ? error.message : String(error)))
