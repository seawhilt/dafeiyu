#!/usr/bin/env node
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { acquireLock, startDaemon } from '../src/daemon.js'
import { callDaemon, ensureDaemon } from '../src/daemon-client.js'
import { daemonPaths } from '../src/daemon-store.js'
import { PROVIDERS } from '../src/provider-hub.js'
import { HOOK_SOURCE_IDS, hookSource } from '../src/providers/registry.js'

const USAGE = `用法: dafeiyu <命令>

  start                 后台启动桌宠守护进程
  stop                  关闭守护进程
  status                查看已接入的产品和正在显示的产品
  settings              打开设置页：接入产品、开关、排序（也可在桌宠右键菜单选择「设置…」）
  install <产品>        为产品写入 hooks，可选：${HOOK_SOURCE_IDS.join(' / ')}
  uninstall <产品>      移除产品的 hooks
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
  let daemon
  try {
    daemon = await startDaemon({ paths, logger, onExit: () => process.exit(0) })
  } catch (error) {
    // A failed start must not leave a lock that looks like a live daemon.
    rmSync(paths.lock, { force: true })
    throw error
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void daemon.close(signal))
}

const labelOf = (id) => PROVIDERS[id]?.label ?? id

function describe(status) {
  const available = status.available.map(labelOf).join('、') || '无'
  return `正在显示: ${status.displayed ? labelOf(status.displayed) : '无'}\n已接入并启用: ${available}`
}

function hooksStatus() {
  return HOOK_SOURCE_IDS
    .map((id) => `${labelOf(id)} hooks: ${hookSource(id).integration.status().installed ? '已安装' : '未安装'}`)
    .join('\n')
}

function sourceFor(id) {
  const source = hookSource(id)
  if (!source) fail(`产品只能是 ${HOOK_SOURCE_IDS.join(' / ')}`)
  return source
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
        return print(`守护进程未运行\n${hooksStatus()}`)
      }
    case 'settings':
      await ensureDaemon()
      await callDaemon('/settings/open', {})
      return print('已在浏览器打开设置页')
    case 'install': {
      const source = sourceFor(args[0])
      if (!source) return undefined
      source.integration.install()
      return print(`已在 ${source.integration.settingsPath()} 写入 ${source.label} hooks（原文件备份为 .dafeiyu.bak）。新开的会话生效。`)
    }
    case 'uninstall': {
      const source = sourceFor(args[0])
      if (!source) return undefined
      return print(source.integration.uninstall() ? `已移除 ${source.label} hooks` : '没有找到 dafeiyu 的配置')
    }
    default:
      print(USAGE)
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1
  }
}

main(process.argv[2], process.argv.slice(3)).catch((error) => fail(error instanceof Error ? error.message : String(error)))
