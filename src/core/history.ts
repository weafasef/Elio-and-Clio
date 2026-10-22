import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 会话历史里一条记录的来源 */
export type EntrySource = '外界消息' | '工具调用' | '工具返回' | '内心活动' | '自由活动'

export type Entry = {
  /** 时间戳：2026/10/20/01/15 */
  t: string
  src: EntrySource
  text: string
  /** 压缩出来的行：这段历史的结束时间（没有就是单个时间点） */
  tEnd?: string
  /** 第几步（网页分组用，不进渲染） */
  step?: number
  /** 这一步的第几轮（网页分组用，不进渲染） */
  loop?: number
}

/** 历史文件位置 */
function historyFile(dataDir: string): string {
  return join(dataDir, 'history', 'history.jsonl')
}

/** 当前时间戳：2026/10/20/01/15（本地时间，全部补零） */
export function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('/') + '/' + [pad(date.getHours()), pad(date.getMinutes())].join('/')
}

/** 追加一行。文件不存在会自动建（含目录）。 */
export function appendHistory(
  dataDir: string,
  src: EntrySource,
  text: string,
  extra: { step?: number, loop?: number } = {},
): Entry {
  const entry: Entry = { t: stamp(), src, text, ...extra }
  const file = historyFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

/** 下一步的编号：历史里最大的 step + 1；没有历史就是 1 */
export function nextStep(dataDir: string): number {
  let max = 0
  for (const entry of readHistory(dataDir)) {
    if (typeof entry.step === 'number' && entry.step > max) max = entry.step
  }
  return max + 1
}

/** 读全部记录（坏行跳过，不让一行坏数据拖垮整个历史） */
export function readHistory(dataDir: string): Entry[] {
  let raw: string
  try {
    raw = readFileSync(historyFile(dataDir), 'utf8')
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Entry
      if (parsed && typeof parsed.t === 'string' && typeof parsed.text === 'string') {
        entries.push(parsed)
      }
    } catch {
      // 跳过坏行
    }
  }
  return entries
}

/**
 * 渲染成给人看的一大段文本（请求里那条 role=user 的内容）。
 *
 *   2026/10/20/01/15  外界消息  主人：在吗
 *   2026/10/20/01/15  内心活动  主人在叫我
 *
 * 历史为空时返回空字符串（调用方会把这条消息整个省掉）。
 */
export function renderHistory(dataDir: string): string {
  return renderEntries(readHistory(dataDir))
}

/** 把一组记录渲染成文本（回看 trace 时按条数截取用） */
export function renderEntries(entries: Entry[]): string {
  return entries
    .map(entry => {
      const when = entry.tEnd && entry.tEnd !== entry.t ? `${entry.t} - ${entry.tEnd}` : entry.t
      return `${when}  ${entry.src}  ${entry.text}`
    })
    .join('\n')
}

// ─────────────────────────── 压缩与档案 ───────────────────────────

/** 档案文件：history/archive/2026-10-21.md */
function archiveFile(dataDir: string, date: string): string {
  return join(dataDir, 'history', 'archive', date.replaceAll('/', '-') + '.md')
}

/**
 * 把一段时间的历史换成一行摘要。
 *
 * - 命中规则：记录的 [t, tEnd] 跟 [start, end] 有交集
 * - 原文整段写进当天档案，分配一个段号
 * - 历史文件用临时文件 + rename 整体替换，写一半崩了也不会坏
 */
export function compressHistory(
  dataDir: string,
  start: string,
  end: string,
  summary: string,
): { removed: number, stamp: string, firstIndex: number } {
  const entries = readHistory(dataDir)

  const hit = (entry: Entry) => {
    const from = entry.t
    const to = entry.tEnd ?? entry.t
    return to >= start && from <= end
  }

  const indexes = entries.map((entry, index) => hit(entry) ? index : -1).filter(index => index >= 0)
  if (indexes.length === 0) {
    throw new Error('这段时间里没有历史记录')
  }

  const first = indexes[0]!
  const last = indexes[indexes.length - 1]!
  const picked = entries.slice(first, last + 1)
  const lastEntry = picked[picked.length - 1]!

  const date = picked[0]!.t.slice(0, 10)                 // 2026/10/21
  const range = `${picked[0]!.t} - ${lastEntry.tEnd ?? lastEntry.t}`
  const id = appendArchive(dataDir, date, range, summary, renderEntries(picked))
  const stampId = `${date}#${id}`

  const replacement: Entry = {
    t: picked[0]!.t,
    tEnd: lastEntry.tEnd ?? lastEntry.t,
    src: '工具返回',
    text: `${summary}（原文在档案 ${stampId}，用 history_read 查看）`,
    step: picked[0]!.step,
  }

  const next = [...entries.slice(0, first), replacement, ...entries.slice(last + 1)]
  writeAll(dataDir, next)

  return { removed: picked.length, stamp: stampId, firstIndex: first }
}

/** 往当天档案追加一段，返回段号（#0001 起） */
function appendArchive(
  dataDir: string,
  date: string,
  range: string,
  summary: string,
  body: string,
): string {
  const file = archiveFile(dataDir, date)
  mkdirSync(dirname(file), { recursive: true })

  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    // 当天还没有档案
  }

  const ids = [...existing.matchAll(/^## #(\d+)/gm)].map(matched => Number(matched[1]))
  const id = String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, '0')

  const block = `## #${id}  ${range}\n摘要：${summary}\n\n--- 原文 ---\n${body}\n\n`
  appendFileSync(file, block, 'utf8')
  return id
}

/** 读回一段档案；找不到返回 null */
export function readArchive(
  dataDir: string,
  date: string,
  id: string,
): { range: string, summary: string, body: string } | null {
  let raw: string
  try {
    raw = readFileSync(archiveFile(dataDir, date), 'utf8')
  } catch {
    return null
  }

  const marker = /^## #(\d+)[ \t]*(.*)$/gm
  const found: Array<{ id: string, range: string, start: number, end: number }> = []
  let matched: RegExpExecArray | null
  while ((matched = marker.exec(raw)) !== null) {
    if (found.length > 0) found[found.length - 1]!.end = matched.index
    found.push({ id: matched[1]!, range: matched[2]!.trim(), start: marker.lastIndex, end: raw.length })
  }

  const segment = found.find(item => item.id === id)
  if (!segment) return null

  const content = raw.slice(segment.start, segment.end).trim()
  const summary = (content.split('\n')[0] ?? '').replace(/^摘要：/, '').trim()
  const bodyAt = content.indexOf('--- 原文 ---')
  const body = bodyAt >= 0 ? content.slice(bodyAt + '--- 原文 ---'.length).trim() : content

  return { range: segment.range, summary, body }
}

/** 整体重写历史文件（原子替换） */
function writeAll(dataDir: string, entries: Entry[]): void {
  const file = historyFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  renameSync(tmp, file)
}
