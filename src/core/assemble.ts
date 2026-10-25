import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHistory } from './history.ts'
import { renderPerception } from './perception.ts'
import type { WakeSource } from './perception.ts'
import { renderMemory } from './memory.ts'
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

export type AssembleResult = {
  request: StreamRequest
  /** 这一轮用的记忆版本 */
  memoryRev: number
  /** 记忆块大约多少 token */
  memoryTokens: number
}

/**
 * 组装一次模型调用的入参。
 *
 *   system   ← 人格提示词
 *   messages ← [会话历史, 记忆文档, 感知缓存]   ← 感知缓存永远在最后
 *   tools    ← 工具表
 *
 * 这里是唯一决定"谁在前谁在后"的地方，缓存规则都集中在这。
 */
export function assemble(input: AssembleInput): AssembleResult {
  const messages: Msg[] = []

  // 会话历史：只追加的那一大段。空历史就整条不发，避免一条空的 user 消息
  const history = renderHistory(input.dataDir)
  if (history) {
    messages.push({ role: 'user', content: history })
  }

  // 记忆文档：慢变化，放在历史后、感知前；空了也发「（空）」
  const memory = renderMemory(input.dataDir)
  messages.push({ role: 'user', content: memory.text })

  // 感知缓存：每轮现算、放最末尾、永不进历史
  let perception = renderPerception({
    dataDir: input.dataDir,
    wakeSource: input.wakeSource,
    usedTokens: input.usedTokens,
    windowTokens: input.windowTokens,
    lastActivityAt: input.lastActivityAt,
    provided: input.provided,
  })

  // 最近一次截图：和感知缓存一起发，图片本身不进历史
  const shotDir = join(input.dataDir, 'screenshots')
  const imagePath = join(shotDir, 'latest.jpg')
  const metaPath = join(shotDir, 'latest.json')

  let image: string | null = null
  try {
    const buffer = readFileSync(imagePath)
    if (buffer.length > 0) image = buffer.toString('base64')
  } catch {
    // 没截过图 / 读不到，保持纯文字
  }

  if (image) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        at?: string
        width?: number
        height?: number
      }
      if (meta.at) {
        const size = meta.width && meta.height ? `（${meta.width}×${meta.height}）` : ''
        perception += `\n- 最近一次截图：${meta.at}${size}`
      }
    } catch {
      // 没有 latest.json 就不写时间
    }

    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: perception },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
      ],
    })
  } else {
    messages.push({ role: 'user', content: perception })
  }

  return {
    request: {
      system: renderPersona(input.dataDir),
      messages,
      tools: listToolSchemas(),
    },
    memoryRev: memory.rev,
    memoryTokens: memory.tokens,
  }
}
