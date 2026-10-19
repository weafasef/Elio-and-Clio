import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 会话历史里一条记录的来源 */
export type EntrySource = '外界消息' | '工具调用' | '工具返回' | '内心活动' | '自由活动'

export type Entry = {
  /** 时间戳：2026/10/20/01/15 */
  t: string
  src: EntrySource
  text: string
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
export function appendHistory(dataDir: string, src: EntrySource, text: string): Entry {
  const entry: Entry = { t: stamp(), src, text }
  const file = historyFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  return entry
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
  return readHistory(dataDir)
    .map(entry => `${entry.t}  ${entry.src}  ${entry.text}`)
    .join('\n')
}
