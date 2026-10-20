import { renderHistory } from './history.ts'
import { renderPerception } from './perception.ts'
import type { WakeSource } from './perception.ts'
import { renderPersona } from './persona.ts'
import { listToolSchemas } from '../registries/tools.ts'
import type { Msg, StreamRequest } from '../model.ts'

export type AssembleInput = {
  dataDir: string
  wakeSource: WakeSource
  /** 上一次响应实际用了多少 prompt token（第一轮没有） */
  usedTokens?: number
  /** 模型窗口 */
  windowTokens: number
  /** 上一步结束的时间 */
  lastActivityAt?: Date
  /** 外面递进来的占位符取值，透传给感知缓存 */
  provided?: Record<string, string>
}

/**
 * 组装一次模型调用的入参。
 *
 *   system   ← 人格提示词
 *   messages ← [会话历史, 感知缓存]   ← 感知缓存永远在最后，且不跟历史合并
 *   tools    ← 工具表
 *
 * 这里是唯一决定"谁在前谁在后"的地方，缓存规则都集中在这。
 */
export function assemble(input: AssembleInput): StreamRequest {
  const messages: Msg[] = []

  // 会话历史：只追加的那一大段。空历史就整条不发，避免一条空的 user 消息
  const history = renderHistory(input.dataDir)
  if (history) {
    messages.push({ role: 'user', content: history })
  }

  // 感知缓存：每轮现算、放最末尾、永不进历史
  messages.push({
    role: 'user',
    content: renderPerception({
      dataDir: input.dataDir,
      wakeSource: input.wakeSource,
      usedTokens: input.usedTokens,
      windowTokens: input.windowTokens,
      lastActivityAt: input.lastActivityAt,
      provided: input.provided,
    }),
  })

  return {
    system: renderPersona(input.dataDir),
    messages,
    tools: listToolSchemas(),
  }
}
