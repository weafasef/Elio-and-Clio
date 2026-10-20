import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTool } from '../registries/tools.ts'

/** 同时最多几个闹钟 */
const MAX_ALARMS = 8
/** 说明最多几个字 */
const MAX_TEXT = 200
/** 最短 / 最长：多久之后 */
const MIN_DELAY_MS = 10_000
const MAX_DELAY_MS = 24 * 60 * 60 * 1000

/** 一个闹钟 */
export type Alarm = {
  /** 4 位编号，用来删除 */
  id: string
  /** 到点时间（本地时间，精确到秒）"2026-10-20T15:30:05" */
  at: string
  /** 到点时看到的话，可以是空字符串 */
  text: string
  /** 什么时候定的 */
  setAt: string
}

// ─────────────────────────────── 存取 ───────────────────────────────

function alarmFile(dataDir: string): string {
  return join(dataDir, 'alarms.json')
}

/** 读全部闹钟，按时间从早到晚。文件没有 / 写坏了 → 空数组 */
export function readAlarms(dataDir: string): Alarm[] {
  let raw: string
  try {
    raw = readFileSync(alarmFile(dataDir), 'utf8')
  } catch {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isAlarm)
      .sort((a, b) => fromIso(a.at).getTime() - fromIso(b.at).getTime())
  } catch {
    return []
  }
}

function isAlarm(value: unknown): value is Alarm {
  if (!value || typeof value !== 'object') return false
  const alarm = value as Record<string, unknown>
  return typeof alarm.id === 'string'
    && typeof alarm.at === 'string'
    && typeof alarm.text === 'string'
    && Number.isFinite(fromIso(alarm.at).getTime())
}

function writeAlarms(dataDir: string, alarms: Alarm[]): void {
  writeFileSync(alarmFile(dataDir), JSON.stringify(alarms, null, 2) + '\n', 'utf8')
}

// ─────────────────────────────── 时间 ───────────────────────────────

/**
 * 把模型给的时间写成具体时刻。
 *
 *   相对：+30s / +12m / +2h
 *   绝对：2026/10/20/15/30（跟历史里的时间戳同一种写法）
 *
 * 其他写法一律报错 —— 不猜"明天下午三点"是几点。
 */
export function parseWhen(input: string, now: Date = new Date()): Date {
  const text = input.trim()

  const relative = /^\+(\d+)\s*([smh])$/i.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]!.toLowerCase()
    const ms = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
    return new Date(now.getTime() + amount * ms)
  }

  const absolute = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})$/.exec(text)
  if (absolute) {
    const [, year, month, day, hour, minute] = absolute.map(Number) as unknown as number[]
    if (
      month! < 1 || month! > 12
      || day! < 1 || day! > 31
      || hour! < 0 || hour! > 23
      || minute! < 0 || minute! > 59
    ) {
      throw new Error(`时间不对：${text}`)
    }
    return new Date(year!, month! - 1, day!, hour!, minute!)
  }

  throw new Error(`时间得写成 +30s / +12m / +2h，或者 2026/10/20/15/30 这样，不能是「${input}」`)
}

/** Date → "2026-10-20T15:30:05"（本地时间） */
function toIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** "2026-10-20T15:30:05" → Date（本地时间）；格式不对 → Invalid Date */
function fromIso(iso: string): Date {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(iso)
  if (!matched) return new Date(Number.NaN)
  const [, year, month, day, hour, minute, second] = matched.map(Number) as unknown as number[]
  return new Date(year!, month! - 1, day!, hour!, minute!, second!)
}

/** 「12 分钟后」/「不到 1 分钟」/「已到点」 */
export function formatRemaining(at: string | Date, now: Date = new Date()): string {
  const target = typeof at === 'string' ? fromIso(at) : at
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return '已到点'

  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟后`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分钟后`
}

/** 「12 分钟后 看看脚本跑完没」；没有说明就只剩时间 */
function describe(alarm: Alarm, now: Date): string {
  const when = formatRemaining(alarm.at, now)
  return alarm.text ? `${when} ${alarm.text}` : when
}

// ─────────────────────────────── 增删查 ───────────────────────────────

export function addAlarm(dataDir: string, when: string, text: string, now: Date = new Date()): Alarm {
  const at = parseWhen(when, now)
  const delay = at.getTime() - now.getTime()

  if (delay < MIN_DELAY_MS) throw new Error('至少得定在 10 秒之后')
  if (delay > MAX_DELAY_MS) throw new Error('最多只能定在 24 小时之内')

  const note = text.trim()
  const length = [...note].length
  if (length > MAX_TEXT) throw new Error(`说明最多 ${MAX_TEXT} 字，你现在写了 ${length} 字，没有保存`)

  const alarms = readAlarms(dataDir)
  if (alarms.length >= MAX_ALARMS) {
    throw new Error(`最多同时有 ${MAX_ALARMS} 个闹钟，先删掉几个再定`)
  }

  const alarm: Alarm = { id: newId(alarms), at: toIso(at), text: note, setAt: toIso(now) }
  alarms.push(alarm)
  writeAlarms(dataDir, alarms)
  return alarm
}

export function cancelAlarm(dataDir: string, id: string): Alarm {
  const alarms = readAlarms(dataDir)
  const index = alarms.findIndex(alarm => alarm.id === id)
  if (index < 0) throw new Error(`没有编号为「${id}」的闹钟`)

  const [removed] = alarms.splice(index, 1)
  writeAlarms(dataDir, alarms)
  return removed!
}

/** 最近的一个闹钟，给感知缓存用的一行字；没有 → 「无」 */
export function nextAlarmText(dataDir: string, now: Date = new Date()): string {
  const alarm = readAlarms(dataDir)[0]
  return alarm ? describe(alarm, now) : '无'
}

/** 已经到点的（还没响、还没删的） */
export function dueAlarms(dataDir: string, now: Date = new Date()): Alarm[] {
  return readAlarms(dataDir).filter(alarm => fromIso(alarm.at).getTime() <= now.getTime())
}

/** 按编号批量删（响完调这个） */
export function removeAlarms(dataDir: string, ids: string[]): void {
  const drop = new Set(ids)
  writeAlarms(dataDir, readAlarms(dataDir).filter(alarm => !drop.has(alarm.id)))
}

/** 4 位十六进制，避开已有的 */
function newId(alarms: Alarm[]): string {
  const used = new Set(alarms.map(alarm => alarm.id))
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = Math.random().toString(16).slice(2, 6).padEnd(4, '0')
    if (!used.has(id)) return id
  }
  throw new Error('生成闹钟编号失败')
}

// ─────────────────────────────── 工具 ───────────────────────────────

registerTool({
  name: 'alarm_set',
  description: '给自己定个闹钟。到点会把我唤醒，历史里会出现一行。',
  parameters: {
    type: 'object',
    properties: {
      when: {
        type: 'string',
        description: '多久之后或具体时刻：+30s / +12m / +2h，或者 2026/10/20/15/30',
      },
      text: {
        type: 'string',
        description: '到点时想让自己看到的话，可以不写',
      },
    },
    required: ['when'],
  },
  run(args, ctx) {
    const text = typeof args.text === 'string' ? args.text : ''
    const alarm = addAlarm(ctx.dataDir, args.when as string, text)
    return `闹钟定好了：#${alarm.id} → ${describe(alarm, new Date())}`
  },
})

registerTool({
  name: 'alarm_list',
  description: '看看自己定了哪些闹钟。没有参数。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const alarms = readAlarms(ctx.dataDir)
    if (alarms.length === 0) return '没有闹钟'

    const now = new Date()
    return alarms
      .map((alarm, index) => `${index + 1}. #${alarm.id}  ${describe(alarm, now)}`)
      .join('\n')
  },
})

registerTool({
  name: 'alarm_cancel',
  description: '删掉一个闹钟。',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '闹钟编号，alarm_list 里那个 # 后面的四位',
      },
    },
    required: ['id'],
  },
  run(args, ctx) {
    const alarm = cancelAlarm(ctx.dataDir, args.id as string)
    return `闹钟已删掉：#${alarm.id}（${describe(alarm, new Date())}）`
  },
})
