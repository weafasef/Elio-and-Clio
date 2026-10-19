/**
 * M0 验证脚本：一条命令验完模型链路。
 *
 *   npm run ping
 *
 * 验 6 项：① 流式文本 ② 单工具调用 ③ 双工具并行 ④ usage ⑤ 缓存命中 ⑥ 耗时
 */
import { loadConfig } from '../src/config.ts'
import { ModelHttpError, streamChat } from '../src/model.ts'
import type { StreamResult, ToolSchema } from '../src/model.ts'

const config = loadConfig()

const OK = '✓'
const NG = '✗'

/** 让终端把收到的字逐片打出来 */
function livePrinter(prefix = '   ') {
  let started = false
  return (piece: string) => {
    if (!started) {
      process.stdout.write(prefix)
      started = true
    }
    process.stdout.write(piece)
  }
}

function line(text = '') {
  process.stdout.write(text + '\n')
}

function section(title: string) {
  line()
  line(title)
}

/** 有工具调用就打印出来 */
function showToolCalls(result: StreamResult) {
  if (!result.toolCalls.length) {
    line(`   （没有工具调用）`)
    return
  }
  for (const [i, call] of result.toolCalls.entries()) {
    line(`   [${i}] ${call.name}  ${JSON.stringify(call.args)}`)
  }
}

function isJsonSafe(result: StreamResult): boolean {
  // streamChat 内部已经 JSON.parse 过；能走到这里说明参数都是合法 JSON
  return result.toolCalls.every(call => call.rawArgs === '' || isParsable(call.rawArgs))
}

function isParsable(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 缓存命中估算：完整 prompt token - 实际处理 token */
function cacheHit(result: StreamResult): { promptTokens?: number, processed?: number, cached?: number } {
  const promptTokens = result.usage?.prompt
  const processed = result.timings?.prompt_n
  const cached = result.usage?.cached
    ?? (promptTokens !== undefined && processed !== undefined ? promptTokens - processed : undefined)
  return { promptTokens, processed, cached }
}

const echoTool: ToolSchema = {
  name: 'echo',
  description: '把传入的文字原样返回',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要原样返回的文字' } },
    required: ['text'],
  },
}

const nowTool: ToolSchema = {
  name: 'now',
  description: '返回当前的 Unix 时间戳',
  parameters: { type: 'object', properties: {} },
}

const results: Array<{ name: string, ok: boolean, note?: string }> = []
function record(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note })
}

// ─────────────────────────────── 开跑 ───────────────────────────────

line('eh · M0 验证')
line(`配置：${config.baseUrl}   模型：${config.model}   窗口：${config.contextWindow}`)

const system = '你是简洁的助手。回答不超过十个字。'

// ① 纯文本流式
section('① 纯文本流式')
let first: StreamResult | undefined
try {
  first = await streamChat(
    { system, messages: [{ role: 'user', content: '说两个字：在呢' }] },
    { onText: livePrinter() },
    { config },
  )
  line()
  const ok = first.text.trim().length > 0 && first.finishReason !== ''
  line(`   首字 ${first.ms.firstToken ?? '-'}ms · 总 ${first.ms.total}ms · finish=${first.finishReason}`)
  record('① 流式文本', ok)
} catch (error) {
  line(`   ${NG} ${describe(error)}`)
  record('① 流式文本', false, describe(error))
}

// ② 单工具调用
section('② 单工具调用')
try {
  const result = await streamChat(
    {
      system,
      messages: [{ role: 'user', content: '请调用 echo 工具，参数 text 传「你好」。只调用工具，不要说话。' }],
      tools: [echoTool],
    },
    {},
    { config },
  )
  showToolCalls(result)
  const ok = result.toolCalls.length === 1 && result.toolCalls[0]!.name === 'echo' && isJsonSafe(result)
  record('② 单工具调用', ok)
} catch (error) {
  line(`   ${NG} ${describe(error)}`)
  record('② 单工具调用', false, describe(error))
}

// ③ 双工具并行
section('③ 双工具并行')
try {
  const result = await streamChat(
    {
      system,
      messages: [{ role: 'user', content: '请同时调用 echo 和 now 两个工具：echo 的 text 传「hi」。不要说话，只调用工具。' }],
      tools: [echoTool, nowTool],
    },
    {},
    { config },
  )
  showToolCalls(result)
  const names = result.toolCalls.map(call => call.name).sort()
  const ok = result.toolCalls.length === 2 && names[0] === 'echo' && names[1] === 'now' && isJsonSafe(result)
  record('③ 双工具并行', ok)
} catch (error) {
  line(`   ${NG} ${describe(error)}`)
  record('③ 双工具并行', false, describe(error))
}

// ④ usage
section('④ usage')
if (first?.usage) {
  line(`   prompt ${first.usage.prompt} / completion ${first.usage.completion} / total ${first.usage.total}`)
  record('④ usage', first.usage.total > 0)
} else {
  line('   没拿到 usage（检查 stream_options.include_usage）')
  record('④ usage', false)
}

// ⑤ 缓存：用一段长前缀，原样发两次
section('⑤ 缓存命中（长前缀，原样发两次）')
try {
  // 拼一段两千多字的前缀，够长才可能命中缓存
  const longPrefix = Array.from({ length: 60 }, (_, i) =>
    `第 ${i + 1} 条规则：回答要短，不要客套，不要复述问题，不要加解释。`).join('\n')

  const askCache = () => streamChat(
    {
      system: longPrefix,
      messages: [{ role: 'user', content: '说一个字：好' }],
    },
    {},
    { config },
  )

  const first = await askCache()
  const second = await askCache()
  const a = cacheHit(first)
  const b = cacheHit(second)
  line(`   第一次：prompt ${a.promptTokens ?? '-'} · 实际处理 ${a.processed ?? '-'} · 命中 ${a.cached ?? '-'}`)
  line(`   第二次：prompt ${b.promptTokens ?? '-'} · 实际处理 ${b.processed ?? '-'} · 命中 ${b.cached ?? '-'}`)
  const hit = (b.cached ?? 0) > 0
  if (!hit) line('   （命中仍为 0：服务端可能没报这个字段，或缓存还没生效）')
  record('⑤ 缓存命中', hit)
} catch (error) {
  line(`   ${NG} ${describe(error)}`)
  record('⑤ 缓存命中', false, describe(error))
}

// ⑥ 耗时
section('⑥ 耗时')
if (first) {
  line(`   首字 ${first.ms.firstToken ?? '-'}ms · 总 ${first.ms.total}ms`)
  record('⑥ 耗时', (first.ms.firstToken ?? 0) > 0)
} else {
  record('⑥ 耗时', false, '① 没跑成')
}

// ─────────────────────────────── 汇总 ───────────────────────────────

section('汇总')
for (const item of results) {
  line(`   ${item.ok ? OK : NG}  ${item.name}${item.note ? `  —— ${item.note}` : ''}`)
}
const failed = results.filter(item => !item.ok).length
line()
line(failed === 0 ? '全部通过，M0 完成。' : `${failed} 项没过。`)

// ─────────────────────────────── 辅助 ───────────────────────────────

function describe(error: unknown): string {
  if (error instanceof ModelHttpError) {
    return `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}${error.nPromptTokens ? ` (prompt ${error.nPromptTokens})` : ''}`
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause ? `${error.message}（${String(cause)}）` : error.message
  }
  return String(error)
}
