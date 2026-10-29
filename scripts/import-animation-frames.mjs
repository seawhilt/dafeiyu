#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [characterPath, exportPath, frameMsArgument = '42'] = process.argv.slice(2)
const frameMs = Number(frameMsArgument)

if (!characterPath || !exportPath || !Number.isFinite(frameMs) || frameMs < 20 || frameMs > 1000) {
  process.stderr.write('用法: node scripts/import-animation-frames.mjs <形象目录> <Spine导出目录> [每帧毫秒数]\n')
  process.exit(2)
}

const characterRoot = resolve(characterPath)
const exportRoot = resolve(exportPath)
const outputRoot = join(characterRoot, 'animations')
const imageName = /^[a-zA-Z0-9_.-]+\.(?:png|webp)$/u
const clipName = /^[a-z][a-z0-9_-]*$/u
const nonLoopingClips = new Set([
  'success', 'error', 'wave', 'jump', 'head_pat', 'poke', 'dragging_release', 'run_right_once', 'run_left_once',
])

function isImage(file) {
  const bytes = readFileSync(file)
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`帧文件过大: ${file}`)
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  return png || webp
}

let previous = {}
try {
  previous = JSON.parse(readFileSync(join(characterRoot, 'animations.json'), 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`无法读取现有 animations.json，已停止导入以保留原清单: ${error.message}`)
}
if (!previous || typeof previous !== 'object' || Array.isArray(previous)
  || (Object.keys(previous).length > 0
    && (previous.formatVersion !== 1 || !previous.clips || typeof previous.clips !== 'object' || Array.isArray(previous.clips)))) {
  throw new Error('现有 animations.json 格式不支持，已停止导入以保留原清单')
}
const clips = { ...(previous.clips ?? {}) }
let imported = 0

for (const entry of readdirSync(exportRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!clipName.test(entry.name)) throw new Error(`动作名只能包含小写字母、数字、下划线和短横线: ${entry.name}`)
  const source = join(exportRoot, entry.name)
  const frames = readdirSync(source).filter((name) => imageName.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (frames.length === 0) continue
  if (frames.length > 2000) throw new Error(`${entry.name} 有 ${frames.length} 帧；每个动作最多支持 2000 帧`)

  const target = join(outputRoot, entry.name)
  mkdirSync(target, { recursive: true })
  for (const frame of frames) {
    const sourceFrame = join(source, frame)
    if (!isImage(sourceFrame)) throw new Error(`不是 PNG/WebP 帧: ${sourceFrame}`)
    copyFileSync(sourceFrame, join(target, basename(frame)))
  }
  clips[entry.name] = {
    frames: frames.map((frame) => `animations/${entry.name}/${frame}`),
    frameMs,
    loop: !nonLoopingClips.has(entry.name),
  }
  imported += frames.length
  process.stdout.write(`${entry.name}: ${frames.length} 帧\n`)
}

if (imported === 0) throw new Error(`导出目录中没有可导入的 PNG/WebP 帧: ${exportRoot}`)
writeFileSync(join(characterRoot, 'animations.json'), `${JSON.stringify({ formatVersion: 1, clips }, null, 2)}\n`)
process.stdout.write(`已导入 ${imported} 帧，动作清单写入 ${join(characterRoot, 'animations.json')}\n`)
