import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { registerTool } from '../registries/tools.ts'

/**
 * 截图：截主屏 → 缩到 640 宽 → 放进 screenshots/latest.jpg
 *
 * 感知缓存每轮读 latest.jpg，所以截完就一直在她眼前，
 * 直到 screenshot_clear 或下一张截图。
 */

const KEEP_SHOTS = 10
const MAX_WIDTH = 640

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

function shotsDir(dataDir: string): string {
  return join(dataDir, 'screenshots')
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`起不了 ${command}：${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300)
    throw new Error(`${command} 失败${detail ? `：${detail}` : ''}`)
  }
}

function imageSize(path: string): { width: number, height: number } {
  const result = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
    encoding: 'utf8',
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const width = Number(/pixelWidth:\s*(\d+)/.exec(text)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(text)?.[1] ?? 0)
  return { width, height }
}

function prune(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(name => name.startsWith('shot-') && name.endsWith('.jpg'))
      .sort()
      .reverse()

    for (const name of files.slice(KEEP_SHOTS)) {
      try { unlinkSync(join(dir, name)) } catch { /* 忽略 */ }
    }
  } catch {
    /* 目录还没建 */
  }
}

registerTool({
  name: 'screenshot',
  description:
    '截取当前主屏（640×400），放进我的感知缓存。' +
    '主人问屏幕上的内容、或者我需要看当前画面时用。' +
    '截完会一直看得见，直到 screenshot_clear 或下一张截图。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const dir = shotsDir(ctx.dataDir)
    mkdirSync(dir, { recursive: true })

    const now = new Date()
    const raw = join(dir, `raw-${fileStamp(now)}.png`)
    const shot = join(dir, `shot-${fileStamp(now)}.jpg`)
    const latest = join(dir, 'latest.jpg')
    const latestTmp = latest + '.tmp'
    const meta = join(dir, 'latest.json')
    const metaTmp = meta + '.tmp'

    try {
      run('/usr/sbin/screencapture', ['-x', '-m', raw])

      let rawSize = 0
      try { rawSize = statSync(raw).size } catch { rawSize = 0 }
      if (rawSize === 0) throw new Error('截图失败：文件是空的')

      run('/usr/bin/sips', [
        '-Z', String(MAX_WIDTH),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '80',
        raw,
        '--out', shot,
      ])

      let shotSize = 0
      try { shotSize = statSync(shot).size } catch { shotSize = 0 }
      if (shotSize === 0) throw new Error('截图失败：缩放后文件是空的')

      const { width, height } = imageSize(shot)

      copyFileSync(shot, latestTmp)
      renameSync(latestTmp, latest)

      writeFileSync(
        metaTmp,
        JSON.stringify({ at: stamp(now), width, height }, null, 2) + '\n',
        'utf8',
      )
      renameSync(metaTmp, meta)

      prune(dir)

      return `截图已更新（${width}×${height}）`
    } finally {
      try { unlinkSync(raw) } catch { /* 已经没了 */ }
      try { unlinkSync(latestTmp) } catch { /* 已经没了 */ }
      try { unlinkSync(metaTmp) } catch { /* 已经没了 */ }
    }
  },
})

registerTool({
  name: 'screenshot_clear',
  description: '把截图从感知缓存里去掉。画面看完了、不需要继续带着时用。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const dir = shotsDir(ctx.dataDir)
    let removed = false

    for (const name of ['latest.jpg', 'latest.json', 'latest.jpg.tmp', 'latest.json.tmp']) {
      try {
        unlinkSync(join(dir, name))
        removed = true
      } catch {
        // 本来就没有
      }
    }

    return removed ? '截图已从感知里去掉' : '感知里本来就没有截图'
  },
})
