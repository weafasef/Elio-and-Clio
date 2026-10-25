/**
 * 语音播放状态：正在说哪句、还有哪些没播、最后一句是什么。
 *
 * 只存在内存里。进程重启后 afplay 本来也会停，队列没有保留的意义。
 * 播放开始/结束时通过 subscribeSpeech 发给网页，舞台据此打字。
 */

export type Speaking = {
  id: number
  text: string
  durationMs: number
  startedAt: number
}

export type Waiting = {
  id: number
  text: string
  durationMs: number
}

export type LastSpeech = Speaking & {
  finishedAt: number
}

export type SpeechEvent =
  | { type: 'start'; id: number; text: string; durationMs: number; startedAt: number }
  | { type: 'end'; id: number; text: string; durationMs: number; startedAt: number; finishedAt: number }

export type SpeechSnapshot = {
  current: Speaking | null
  pending: Waiting[]
  last: LastSpeech | null
}

let current: Speaking | null = null
let pending: Waiting[] = []
let last: LastSpeech | null = null

const listeners = new Set<(event: SpeechEvent) => void>()

/** 合成完、进入播放队列 */
export function queueSpeech(id: number, text: string, durationMs = 0): void {
  pending.push({ id, text, durationMs })
}

/** 开始播放（从等待队列里移出来） */
export function startSpeech(id: number, text: string, durationMs = 0): void {
  const index = pending.findIndex(item => item.id === id)
  if (index >= 0) pending.splice(index, 1)

  const item: Speaking = {
    id,
    text,
    durationMs,
    startedAt: Date.now(),
  }
  current = item
  emit({ type: 'start', ...item })
}

/** 这一句播完了 */
export function finishSpeech(id: number): void {
  const active = current
  if (!active || active.id !== id) return

  const done: LastSpeech = {
    ...active,
    finishedAt: Date.now(),
  }
  last = done
  current = null
  emit({ type: 'end', ...done })
}

/** 给感知缓存用的一行；没有语音时是「无」 */
export function renderSpeechState(): string {
  const parts: string[] = []

  if (current) parts.push(`正在说「${clip(current.text)}」`)

  if (pending.length > 0) {
    const shown = pending.slice(0, 6).map(item => `「${clip(item.text)}」`).join('')
    const more = pending.length > 6 ? '…' : ''
    parts.push(`未播放 ${pending.length} 句：${shown}${more}`)
  }

  return parts.length > 0 ? parts.join('；') : '无'
}

/** 舞台连接时补当前状态 */
export function speechSnapshot(): SpeechSnapshot {
  return {
    current: current ? { ...current } : null,
    pending: pending.map(item => ({ ...item })),
    last: last ? { ...last } : null,
  }
}

/** 播放开始/结束的订阅；返回取消订阅函数 */
export function subscribeSpeech(listener: (event: SpeechEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: SpeechEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // 一个网页出错不能影响播放
    }
  }
}

/** 每句最多显示 40 个字，避免长句把感知缓存撑大 */
function clip(text: string, max = 40): string {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text
}
