import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 唤醒来源（这一 step 是被什么开启的） */
export type WakeSource = '外界消息' | '工具调用' | '工具返回' | '自由活动'

export type PerceptionInput = {
  /** 实例目录，用来读 perception.json 和 memo.txt */
  dataDir: string
  /** 这一 step 是被什么开启的 */
  wakeSource: WakeSource
  /** 上一次响应实际用了多少 prompt token（第一轮没有） */
  usedTokens?: number
  /** 模型窗口 */
  windowTokens: number
  /** 上一步结束的时间（算"距上次活动"） */
  lastActivityAt?: Date
  /** 现在（测试时可以传固定值） */
  now?: Date
}

/** 配置里的形状 */
type PerceptionConfig = {
  title?: string
  lines?: string[]
}

/** 没有配置文件时的默认配置（跟方案里的示例一致） */
const DEFAULT_CONFIG: PerceptionConfig = {
  title: '【感知缓存】',
  lines: [
    '- 当前时间：{{time}}（距上次活动 {{elapsed}}）',
    '- 下一个闹钟还有：{{alarm}}',
    '- 唤醒来源：{{wake}}',
    '- 上下文占用率：{{usage}}',
    '- 我的备忘录：{{memo}}',
  ],
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 渲染感知缓存：读配置 → 逐行替换 {{占位符}} → 拼成一段文本。
 *
 * - 顺序 = 配置里的顺序；删掉哪行就不显示哪行
 * - 文件不存在 → 用内置默认
 * - 不认识的占位符 → 原样保留（方便发现"这个还没实现"）
 * - 每轮重新读，改完下一轮生效
 */
export function renderPerception(input: PerceptionInput): string {
  const config = readConfig(input.dataDir)
  const values = collectValues(input)

  const title = config.title ?? DEFAULT_CONFIG.title!
  const lines = (config.lines ?? DEFAULT_CONFIG.lines!).map(line =>
    line.replace(/\{\{\s*([\w\u4e00-\u9fa5]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole),
  )

  return [title, ...lines].join('\n')
}

// ─────────────────────────────── 取值 ───────────────────────────────

function collectValues(input: PerceptionInput): Record<string, string> {
  const now = input.now ?? new Date()
  const used = input.usedTokens
  const percent = used === undefined ? undefined : Math.round((used / input.windowTokens) * 100)

  return {
    time: `${formatDate(now)} ${WEEKDAYS[now.getDay()]} ${formatClock(now)}`,
    elapsed: formatElapsed(now, input.lastActivityAt),
    // 闹钟还没实现
    alarm: '无',
    wake: input.wakeSource,
    usage: used === undefined || percent === undefined
      ? '无'
      : `${percent}%。${used}/${input.windowTokens} token`,
    memo: readMemo(input.dataDir),
  }
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatElapsed(now: Date, since?: Date): string {
  if (!since) return '无'
  const minutes = Math.floor((now.getTime() - since.getTime()) / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天`
}

/** 备忘录：去掉首尾空白，空 → 「无」，最多显示 200 字 */
function readMemo(dataDir: string): string {
  let text: string
  try {
    text = readFileSync(join(dataDir, 'memo.txt'), 'utf8').trim()
  } catch {
    return '无'
  }
  if (!text) return '无'
  const chars = [...text]
  return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : text
}

// ─────────────────────────────── 读配置 ───────────────────────────────

function readConfig(dataDir: string): PerceptionConfig {
  let raw: string
  try {
    raw = readFileSync(join(dataDir, 'perception.json'), 'utf8')
  } catch {
    return DEFAULT_CONFIG
  }

  try {
    const parsed = JSON.parse(raw) as PerceptionConfig
    return {
      title: typeof parsed.title === 'string' ? parsed.title : DEFAULT_CONFIG.title,
      lines: Array.isArray(parsed.lines)
        ? parsed.lines.filter((line): line is string => typeof line === 'string')
        : DEFAULT_CONFIG.lines,
    }
  } catch {
    // 配置写坏了就用默认，不让程序起不来
    return DEFAULT_CONFIG
  }
}
