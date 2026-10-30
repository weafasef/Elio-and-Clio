import { assemble } from './assemble.ts'
import { formatToolCall } from './format.ts'
import { appendHistory, readHistory, stamp } from './history.ts'
import type { EntryInput, EntrySource } from './history.ts'
import type { WakeSource } from './perception.ts'
import { saveTrace } from './trace.ts'
import { recordCall } from './metrics.ts'
import { summarizeChanges } from './memory.ts'
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
  /** 每往历史里写一条（网页用它实时刷新） */
  onHistory?: () => void
  /**
   * 给感知缓存的占位符取值（比如闹钟）。
   *
   * 每轮都会调一次，所以里面的数字是"此刻"的。
   * 返回 { alarm: "12 分钟后…" } 这种字典，core 不关心内容。
   */
  perception?: () => Record<string, string>
  /**
   * 每一轮开始前，把排队的东西取走（跟 perception 一样是回调）。
   *
   * 主人说的话、到点的闹钟都从这里进来 —— 不用等这一步结束。
   * 返回的内容会写进历史，这一轮的请求就带上了。
   */
  takeQueued?: () => Array<{ src: EntrySource, text: string, input?: EntryInput }>
  /** 本步结束 */
  onDone?: () => void
  /** 外部喊停（网页上的「停止」） */
  signal?: AbortSignal
}

/**
 * 上一步结束的时间。进程重启后从会话历史最后一条推出来，
 * 这样重启后"距上次活动"也是个合理的数字。
 */
let lastActivityAt: Date | undefined

/** 上一条 trace 记的记忆版本；用来只记录版本之间的变化 */
let lastTraceMemoryRev: number | undefined

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

  /** 写历史 + 通知网页 */
  const log = (
    src: EntrySource,
    text: string,
    extra: { step?: number, loop?: number, input?: EntryInput } = {},
  ) => {
    appendHistory(dataDir, src, text, extra)
    events.onHistory?.()
  }

  try {
    while (true) {
      if (events.signal?.aborted) break
      loop++
      events.onLoopStart?.(loop)

      // 排队进来的东西：主人说的话、到点的闹钟，下一轮就带上
      const queued = events.takeQueued?.() ?? []
      if (queued.length > 0) {
        for (const item of queued) {
          log(item.src, item.text, {
            step: stepId,
            loop,
            ...(item.input ? { input: item.input } : {}),
          })
        }
        if (queued.some(item => item.src === '外界消息')) {
          wakeSource = '外界消息'
        }
      }

      const assembled = assemble({
        dataDir,
        wakeSource,
        usedTokens,
        windowTokens: config.contextWindow,
        lastActivityAt,
        // 每轮现算（闹钟剩余时间会变）
        provided: events.perception?.(),
      })
      const request = assembled.request

      // 记忆变了才把变化摘要写进 trace；没变就只有版本号
      let memoryChange: string | undefined
      if (lastTraceMemoryRev !== undefined && assembled.memoryRev > lastTraceMemoryRev) {
        const summary = summarizeChanges(dataDir, lastTraceMemoryRev, assembled.memoryRev)
        if (summary) memoryChange = summary
      }
      lastTraceMemoryRev = assembled.memoryRev

      let result
      try {
        result = await streamChat(
          request,
          { onText: events.onText },
          { config, signal: events.signal },
        )
      } catch (error) {
        if (events.signal?.aborted) {
          log('工具返回', '已停止', { step: stepId, loop })
          break
        }
        const message = error instanceof Error ? error.message : String(error)
        log('工具返回', `请求失败：${message}`, { step: stepId, loop })
        break
      }

      // 下一次感知缓存里的占用率，用这一次实际用了多少
      usedTokens = result.usage?.prompt ?? usedTokens

      // 首 token / 速度统计，给下一轮的感知缓存看
      recordCall(dataDir, {
        firstTokenMs: result.ms.firstToken,
        totalMs: result.ms.total,
        completionTokens: result.usage?.completion ?? null,
      })

      // 落一条 trace：只存"算不出来"的部分（历史按条数重建）
      const lastContent = request.messages.at(-1)?.content
      const perceptionText = typeof lastContent === 'string'
        ? lastContent
        : (lastContent ?? [])
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n')

      let perception = perceptionText
      if (Array.isArray(lastContent) && lastContent.some(part => part.type === 'image_url')) {
        const matched = /- 最近一次截图：(.+?)（(.+?)）/.exec(perceptionText)
        perception += matched
          ? `\n[截图 ${matched[2]} · ${matched[1]}]`
          : '\n[截图]'
      }

      saveTrace(dataDir, {
        t: stamp(),
        step: stepId,
        loop,
        historyCount: readHistory(dataDir).length,
        memoryRev: assembled.memoryRev,
        memoryTokens: assembled.memoryTokens,
        ...(memoryChange ? { memoryChange } : {}),
        system: request.system ?? '',
        perception,
        tools: (request.tools ?? []).map(tool => tool.name),
        response: {
          text: result.text,
          reasoning: result.reasoning,
          toolCalls: result.toolCalls.map(call => ({ id: call.id, name: call.name, args: call.args })),
          finishReason: result.finishReason,
          usage: result.usage,
        },
      })

      // 思维链和最终文字都算内心活动；完全相同就只记一次
      const reasoning = result.reasoning.trim()
      const text = result.text.trim()
      if (reasoning) {
        log('内心活动', reasoning, { step: stepId, loop })
      }
      if (text && text !== reasoning) {
        log('内心活动', text, { step: stepId, loop })
      }

      // 没调任何工具 → 继续下一轮（只有 sleep 能结束）
      if (result.toolCalls.length === 0) {
        continue
      }

      // 逐个执行工具
      let shouldStop = false
      for (const call of result.toolCalls) {
        if (events.signal?.aborted) break
        events.onToolCall?.(call.name)
        log('工具调用', formatToolCall(call.name, call.args), { step: stepId, loop })
        const output = await runTool(call.name, call.args, { dataDir })
        log('工具返回', output, { step: stepId, loop })
        if (call.name === 'sleep') shouldStop = true
      }

      // 之后每一轮都是"工具返回"把我推进来的
      wakeSource = '工具返回'

      if (events.signal?.aborted) break
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
