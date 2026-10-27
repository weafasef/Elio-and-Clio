import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTool } from '../../registries/tools.ts'

/**
 * 摄像头拍照：调用一个很小的原生 app，拍完缩成 640 宽 JPEG，
 * 放进 screenshots/latest.jpg，和屏幕截图共用一份视觉缓存。
 */

const moduleDir = dirname(fileURLToPath(import.meta.url))
const helperDir = join(moduleDir, 'camera-helper')
const helperSource = join(helperDir, 'camera.m')
const helperInfo = join(helperDir, 'Info.plist')

type CameraResult = {
  ok?: boolean
  error?: string
  width?: number
  height?: number
}

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('/') + ' ' + [pad(date.getHours()), pad(date.getMinutes())].join(':')
}

function fileStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
}

function run(command: string, args: string[], timeout = 120_000): void {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout })
  if (result.error) throw new Error(`起不了 ${command}：${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500)
    throw new Error(`${command} 失败${detail ? `：${detail}` : ''}`)
  }
}

function ensureHelper(ctx: { dataDir: string }): string {
  const appDir = join(ctx.dataDir, 'camera', 'EHCamera.app')
  const contentsDir = join(appDir, 'Contents')
  const binary = join(contentsDir, 'MacOS', 'camera')
  const info = join(contentsDir, 'Info.plist')

  const sourceTime = Math.max(
    statSync(helperSource).mtimeMs,
    statSync(helperInfo).mtimeMs,
  )
  if (existsSync(binary) && existsSync(info) && statSync(binary).mtimeMs >= sourceTime) {
    return appDir
  }

  mkdirSync(join(contentsDir, 'MacOS'), { recursive: true })
  run('/usr/bin/clang', [
    '-fobjc-arc',
    '-framework', 'AVFoundation',
    '-framework', 'AppKit',
    '-framework', 'ImageIO',
    '-framework', 'CoreGraphics',
    `-Wl,-sectcreate,__TEXT,__info_plist,${helperInfo}`,
    helperSource,
    '-o', binary,
  ])
  copyFileSync(helperInfo, info)
  chmodSync(binary, 0o755)
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appDir])
  return appDir
}

function imageSize(path: string): { width: number, height: number } {
  const result = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
    encoding: 'utf8',
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(text)?.[1] ?? 0),
    height: Number(/pixelHeight:\s*(\d+)/.exec(text)?.[1] ?? 0),
  }
}

registerTool({
  name: 'camera',
  description:
    '用摄像头拍一张照片，放进我的当前视觉缓存。' +
    '主人让我看看眼前、或者想让我自拍时用。' +
    '拍完会一直看得见，直到下一张照片或截图。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    if (process.platform !== 'darwin') {
      throw new Error('摄像头工具目前只支持 macOS')
    }

    const helperApp = ensureHelper(ctx)
    const cameraDir = join(ctx.dataDir, 'camera')
    const shotsDir = join(ctx.dataDir, 'screenshots')
    mkdirSync(cameraDir, { recursive: true })
    mkdirSync(shotsDir, { recursive: true })

    const now = new Date()
    const raw = join(cameraDir, `raw-${fileStamp(now)}.jpg`)
    const status = join(cameraDir, `status-${fileStamp(now)}.json`)
    const resized = join(cameraDir, `photo-${fileStamp(now)}.jpg`)
    const latest = join(shotsDir, 'latest.jpg')
    const latestTmp = join(shotsDir, 'latest.tmp.jpg')
    const meta = join(shotsDir, 'latest.json')
    const metaTmp = join(shotsDir, 'latest.tmp.json')

    try {
      const opened = spawnSync('/usr/bin/open', [
        '-W',
        '-a', helperApp,
        '--args', raw, status,
      ], { encoding: 'utf8', timeout: 60_000 })

      if (opened.error) throw new Error(`启动拍照程序失败：${opened.error.message}`)
      if (opened.status !== 0) {
        const detail = (opened.stderr || opened.stdout || '').trim().slice(0, 300)
        throw new Error(`启动拍照程序失败${detail ? `：${detail}` : ''}`)
      }

      let result: CameraResult = {}
      try {
        result = JSON.parse(readFileSync(status, 'utf8')) as CameraResult
      } catch {
        // 没有状态文件时，下面统一报错
      }

      if (!result.ok) {
        throw new Error(result.error || '拍照失败')
      }

      run('/usr/bin/sips', [
        '-Z', '640',
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '80',
        raw,
        '--out', resized,
      ])

      const { width, height } = imageSize(resized)
      if (!width || !height) throw new Error('照片尺寸读取失败')

      copyFileSync(resized, latestTmp)
      renameSync(latestTmp, latest)

      writeFileSync(
        metaTmp,
        JSON.stringify({
          at: stamp(now),
          width,
          height,
          source: 'camera',
        }, null, 2) + '\n',
        'utf8',
      )
      renameSync(metaTmp, meta)

      return `照片已更新（${width}×${height}）`
    } finally {
      for (const path of [raw, status, resized, latestTmp, metaTmp]) {
        try { rmSync(path, { force: true }) } catch { /* 已经没了 */ }
      }
    }
  },
})
