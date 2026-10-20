import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Usage } from '../model.ts'

/** 那一次的响应 */
export type TraceResponse = {
  text: string
  toolCalls: Array<{ id: string, name: string, args: unknown }>
  finishReason: string
  usage?: Usage
}

/**
 * 一条调用记录。
 *
 * 只存"每次会变、又算不出来"的部分：
 * - system：几百字，但她会改人格，不存就看不到"当时"的版本
 * - perception：每轮都变
 * - historyCount：这一轮请求里用了历史的前多少条（历史本身从 history.jsonl 重建）
 */
export type TraceRecord = {
  t: string
  step: number
  loop: number
  historyCount: number
  system: string
  perception: string
  tools: string[]
  response: TraceResponse
}

function traceFile(dataDir: string): string {
  return join(dataDir, 'trace', 'trace.jsonl')
}

/** 追加一条记录 */
export function saveTrace(dataDir: string, record: TraceRecord): void {
  const file = traceFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

/** 按 step + loop 找一条记录（从后往前找，最近的优先）；找不到返回 null */
export function findTrace(dataDir: string, step: number, loop: number): TraceRecord | null {
  let raw: string
  try {
    raw = readFileSync(traceFile(dataDir), 'utf8')
  } catch {
    return null
  }

  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      const record = JSON.parse(line) as TraceRecord
      if (record.step === step && record.loop === loop) return record
    } catch {
      // 跳过坏行
    }
  }
  return null
}
