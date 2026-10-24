/**
 * 语音播放状态：正在说哪句、还有哪些没播。
 *
 * 只存在内存里。进程重启后 afplay 本来也会停，队列没有保留的意义。
 */

type SpeechItem = {
  id: number
  text: string
}

let current: SpeechItem | null = null
let pending: SpeechItem[] = []

/** 合成完、进入播放队列 */
export function queueSpeech(id: number, text: string): void {
  pending.push({ id, text })
}

/** 开始播放（从等待队列里移出来） */
export function startSpeech(id: number, text: string): void {
  const index = pending.findIndex(item => item.id === id)
  if (index >= 0) pending.splice(index, 1)
  current = { id, text }
}

/** 这一句播完了 */
export function finishSpeech(id: number): void {
  if (current?.id === id) current = null
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

/** 每句最多显示 40 个字，避免长句把感知缓存撑大 */
function clip(text: string, max = 40): string {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text
}
