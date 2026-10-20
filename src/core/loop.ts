import { assemble } from './assemble.ts'
import { formatToolCall } from './format.ts'
import { appendHistory, readHistory, stamp } from './history.ts'
import type { WakeSource } from './perception.ts'
import { saveTrace } from './trace.ts'
import { runTool } from '../registries/tools.ts'
import { streamChat } from '../model.ts'
import type { Config } from '../config.ts'

export type StepEvents = {
  /** 第几步（由调用方用 nextStep() 算好） */
  stepId: number
  /** 这一轮被什么唤醒 */
  wakeSource: WakeSource
  /** 每收到一片文字（网页用它实时显示） */
  onText?: (piece: string) => void
  /** 每一轮开始时（从 1 开始） */
  onLoopStart?: (loop: number) => void
  /** 每执行一个工具时 */
  onToolCall?: (name: string) => void
  /** 本步结束 */
  onDone?: () => void
}

/**
 * 上一步结束的时间。进程重启后从会话历史最后一条推出来，
 * 这样重启后"距上次活动"也是个合理的数字。
 */
let lastActivityAt: Date | undefined

/**
 * 跑完一步（step = 若干轮 loop）。
 *
 * 规则：
 * - 只有调了 sleep 才结束（没有工具调用也会继续下一轮）
 * - 第一次的唤醒来源是传进来的那个，之后每一轮都是「工具返回」
 * - 请求失败 → 记一行「请求失败：…」，结束本步，进程不崩
 * - 每一次调用都落一条 trace（请求 + 响应）
 */
export async function runStep(config: Config, events: StepEvents): Promise<void> {
  const dataDir = config.dataDir
  const stepId = events.stepId
  lastActivityAt ??= lastEntryTime(dataDir)

  let usedTokens: number | undefined
  let wakeSource: WakeSource = events.wakeSource
  let loop = 0

  try {
    while (true) {
      loop++
      events.onLoopStart?.(loop)

      const request = assemble({
        dataDir,
        wakeSource,
        usedTokens,
        windowTokens: config.contextWindow,
        lastActivityAt,
      })

      let result
      try {
        result = await streamChat(request, { onText: events.onText }, { config })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendHistory(dataDir, '工具返回', `请求失败：${message}`, { step: stepId, loop })
        break
      }

      // 下一次感知缓存里的占用率，用这一次实际用了多少
      usedTokens = result.usage?.prompt ?? usedTokens

      // 落一条 trace：只存"算不出来"的部分（历史按条数重建）
      saveTrace(dataDir, {
        t: stamp(),
        step: stepId,
        loop,
        historyCount: readHistory(dataDir).length,
        system: request.system ?? '',
        perception: request.messages.at(-1)?.content ?? '',
        tools: (request.tools ?? []).map(tool => tool.name),
        response: {
          text: result.text,
          toolCalls: result.toolCalls.map(call => ({ id: call.id, name: call.name, args: call.args })),
          finishReason: result.finishReason,
          usage: result.usage,
        },
      })

      // 文字 → 内心活动
      if (result.text) {
        appendHistory(dataDir, '内心活动', result.text, { step: stepId, loop })
      }

      // 没调任何工具 → 继续下一轮（只有 sleep 能结束）
      if (result.toolCalls.length === 0) {
        continue
      }

      // 逐个执行工具
      let shouldStop = false
      for (const call of result.toolCalls) {
        events.onToolCall?.(call.name)
        appendHistory(dataDir, '工具调用', formatToolCall(call.name, call.args), { step: stepId, loop })
        const output = await runTool(call.name, call.args, { dataDir })
        appendHistory(dataDir, '工具返回', output, { step: stepId, loop })
        if (call.name === 'sleep') shouldStop = true
      }

      // 之后每一轮都是"工具返回"把我推进来的
      wakeSource = '工具返回'

      if (shouldStop) break
    }
  } finally {
    lastActivityAt = new Date()
    events.onDone?.()
  }
}

/** 从会话历史最后一条推出时间；没有历史就返回 undefined */
function lastEntryTime(dataDir: string): Date | undefined {
  const last = readHistory(dataDir).at(-1)
  if (!last) return undefined

  const matched = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})$/.exec(last.t)
  if (!matched) return undefined

  const [, year, month, day, hour, minute] = matched
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  )
}
