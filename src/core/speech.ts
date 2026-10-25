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
  /** 0–1 的响度包络，50ms 一帧 */
  envelope: number[]
  envelopeRate: number
}

export type Waiting = {
  id: number
  text: string
  durationMs: number
  envelope: number[]
  envelopeRate: number
}

export type LastSpeech = Speaking & {
  finishedAt: number
}

export type SpeechEvent =
  | {
      type: 'start'
      id: number
      text: string
      durationMs: number
      startedAt: number
      envelope: number[]
      envelopeRate: number
    }
  | {
      type: 'end'
      id: number
      text: string
      durationMs: number
      startedAt: number
      finishedAt: number
      envelope: number[]
      envelopeRate: number
    }

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
export function queueSpeech(
  id: number,
  text: string,
  durationMs = 0,
  envelope: number[] = [],
  envelopeRate = 20,
): void {
  pending.push({ id, text, durationMs, envelope, envelopeRate })
}

/** 开始播放（从等待队列里移出来） */
export function startSpeech(
  id: number,
  text: string,
  durationMs = 0,
  envelope: number[] = [],
  envelopeRate = 20,
): void {
  const index = pending.findIndex(item => item.id === id)
  if (index >= 0) pending.splice(index, 1)

  const item: Speaking = {
    id,
    text,
    durationMs,
    startedAt: Date.now(),
    envelope,
    envelopeRate,
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
    current: current ? { ...current, envelope: [...current.envelope] } : null,
    pending: pending.map(item => ({ ...item, envelope: [...item.envelope] })),
    last: last ? { ...last, envelope: [...last.envelope] } : null,
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
