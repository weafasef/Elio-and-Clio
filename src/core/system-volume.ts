import { execFileSync } from 'node:child_process'

/**
 * 系统输出音量（macOS）。
 *
 * 惰性读取：每次渲染感知时读一次，1 秒内复用结果。
 * 用 osascript 的 Standard Additions 读取，不需要额外权限。
 */

const SCRIPT = `
set s to get volume settings
set v to output volume of s
set m to output muted of s
if v is missing value then return "missing," & (m as text)
return (v as text) & "," & (m as text)
`

const CACHE_MS = 1000
const TIMEOUT_MS = 800

let cachedAt = 0
let cachedText = ''

/** 感知缓存里的一行：38% / 38%（已静音）/ 0% */
export function renderSystemVolume(): string {
  if (process.platform !== 'darwin') return '非 macOS'

  const now = Date.now()
  if (now - cachedAt < CACHE_MS && cachedText) return cachedText

  try {
    const output = execFileSync('/usr/bin/osascript', ['-e', SCRIPT], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    const text = formatReading(output)
    cachedAt = now
    cachedText = text
    return text
  } catch (error) {
    return isTimeout(error) ? '超时' : '读取失败'
  }
}

function formatReading(output: string): string {
  const [rawVolume, rawMuted] = output.split(',')
  const muted = rawMuted === 'true'

  // 部分 HDMI / 外接声卡没有软件音量
  if (rawVolume === 'missing') return '设备不支持'

  const volume = Number(rawVolume)
  if (!Number.isFinite(volume)) return '读取失败'

  const percent = Math.min(100, Math.max(0, Math.round(volume)))
  if (percent === 0) return '0%'
  return muted ? `${percent}%（已静音）` : `${percent}%`
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  const signal = (error as { signal?: unknown }).signal
  return code === 'ETIMEDOUT' || signal === 'SIGTERM'
}
