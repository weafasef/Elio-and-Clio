/**
 * 解析器自测：用一个本地假服务器，喂各种"变态"的流式数据，验证 model.ts 的解析是否正确。
 *
 *   node scripts/self-test.ts
 *
 * 不连真实模型、不依赖网络。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '../src/config.ts'
import { IdleTimeoutError, ModelHttpError, streamChat } from '../src/model.ts'
import type { Config } from '../src/config.ts'

const PORT = 18_099
const BASE = `http://127.0.0.1:${PORT}/v1`
const baseConfig: Config = { ...loadConfig(), baseUrl: BASE }

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

let handler: Handler = async (_req, res) => {
  res.writeHead(404).end()
}

const server = createServer((req, res) => {
  void handler(req, res).catch((error: unknown) => {
    console.error('假服务器出错：', error)
    res.destroy()
  })
})
await new Promise<void>(resolve => server.listen(PORT, '127.0.0.1', resolve))

/** 把一整段文本按任意字节位置切片发出去（故意切在多字节汉字中间） */
async function writeSliced(res: ServerResponse, text: string, sliceSize: number) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const bytes = Buffer.from(text, 'utf8')
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    res.write(bytes.subarray(offset, offset + sliceSize))
    await sleep(2)
  }
  res.end()
}

// ───────────────────────────── 用例 ─────────────────────────────

const results: Array<{ name: string, ok: boolean, detail?: string }> = []
const record = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail })

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

// 1. 文本流：汉字被切在两个字节块之间
{
  const payload =
    sse({ choices: [{ delta: { role: 'assistant' } }] }) +
    sse({ choices: [{ delta: { content: '你' } }] }) +
    sse({ choices: [{ delta: { content: '好' } }] }) +
    sse({ choices: [{ delta: { content: '呀' } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    sse({ usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20, prompt_tokens_details: { cached_tokens: 12 } } }) +
    sse({ timings: { prompt_n: 5, predicted_n: 3 } }) +
    'data: [DONE]\n\n'

  handler = async (_req, res) => writeSliced(res, payload, 7) // 每块 7 字节，必然切碎汉字

  try {
    const pieces: string[] = []
    const result = await streamChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onText: piece => pieces.push(piece) },
      { config: baseConfig, retries: 1 },
    )
    assert(result.text === '你好呀', `文本拼错了：${result.text}`)
    assert(pieces.join('') === '你好呀', 'onText 回调拼起来不对')
    assert(result.finishReason === 'stop', `finishReason=${result.finishReason}`)
    assert(result.usage?.prompt === 17 && result.usage.cached === 12, 'usage 不对')
    assert(result.timings?.prompt_n === 5, 'timings 不对')
    assert(result.ms.firstToken !== null && result.ms.firstToken >= 0, 'firstToken 不对')
    record('① 文本流（汉字被切碎）', true)
  } catch (error) {
    record('① 文本流（汉字被切碎）', false, String(error))
  }
}

// 2. 两个工具并行，参数碎片交错
{
  const payload =
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'echo', arguments: '{"te' } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'now', arguments: '{' } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"你好"}' } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '}' } }] } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'

  handler = async (_req, res) => writeSliced(res, payload, 11)

  try {
    const result = await streamChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      { config: baseConfig, retries: 1 },
    )
    assert(result.toolCalls.length === 2, `工具调用数量 ${result.toolCalls.length}`)
    assert(result.toolCalls[0]!.name === 'echo', `第0个名字 ${result.toolCalls[0]!.name}`)
    assert(JSON.stringify(result.toolCalls[0]!.args) === JSON.stringify({ text: '你好' }), `第0个参数 ${JSON.stringify(result.toolCalls[0]!.args)}`)
    assert(result.toolCalls[1]!.name === 'now', `第1个名字 ${result.toolCalls[1]!.name}`)
    assert(result.toolCalls[1]!.args && typeof result.toolCalls[1]!.args === 'object', '第1个参数应为 {}')
    assert(result.finishReason === 'tool_calls', `finishReason=${result.finishReason}`)
    record('② 双工具并行（参数交错）', true)
  } catch (error) {
    record('② 双工具并行（参数交错）', false, String(error))
  }
}

// 3. 参数不是合法 JSON → 必须报 ToolArgsError，且带原始字符串
{
  const payload =
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'echo', arguments: '{"text":' } }] } }] }) +
    'data: [DONE]\n\n'
  handler = async (_req, res) => writeSliced(res, payload, 999)

  try {
    await streamChat({ messages: [{ role: 'user', content: 'hi' }] }, {}, { config: baseConfig, retries: 1 })
    record('③ 坏参数被识别', false, '本该报错却没报')
  } catch (error) {
    const message = String(error)
    record('③ 坏参数被识别', message.includes('不是合法 JSON'), message.slice(0, 80))
  }
}

// 4. 空闲超时
{
  handler = async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(sse({ choices: [{ delta: { content: '半' } }] }))
    await sleep(5_000) // 然后装死
    res.end()
  }

  try {
    await streamChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      { config: { ...baseConfig, idleTimeoutMs: 300 }, retries: 1 },
    )
    record('④ 空闲超时', false, '本该超时却没超时')
  } catch (error) {
    record('④ 空闲超时', error instanceof IdleTimeoutError, String(error).slice(0, 80))
  }
}

// 5. 4xx 错误：要带回 code 和 n_prompt_tokens，而且不重试
{
  let hits = 0
  handler = async (_req, res) => {
    hits++
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      code: 400,
      message: 'request (134877 tokens) exceeds the available context size (131072 tokens)',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 134_877,
      n_ctx: 131_072,
    }))
  }

  try {
    await streamChat({ messages: [{ role: 'user', content: 'hi' }] }, {}, { config: baseConfig })
    record('⑤ 400 错误归类', false, '本该抛错')
  } catch (error) {
    const ok = error instanceof ModelHttpError
      && error.status === 400
      && error.nPromptTokens === 134_877
      && hits === 1
    record('⑤ 400 错误归类（且不重试）', ok, ok ? undefined : `hits=${hits} ${String(error).slice(0, 60)}`)
  }
}

// 6. 5xx 会重试
{
  let hits = 0
  handler = async (_req, res) => {
    hits++
    if (hits === 1) {
      res.writeHead(503).end('busy')
      return
    }
    await writeSliced(res, sse({ choices: [{ delta: { content: 'ok' } }, ] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', 999)
  }

  try {
    const result = await streamChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      { config: baseConfig, retries: 2 },
    )
    record('⑥ 5xx 自动重试', result.text === 'ok' && hits === 2, `text=${result.text} hits=${hits}`)
  } catch (error) {
    record('⑥ 5xx 自动重试', false, String(error).slice(0, 80))
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────

console.log()
for (const item of results) {
  console.log(`  ${item.ok ? '✓' : '✗'}  ${item.name}${item.detail ? `  —— ${item.detail}` : ''}`)
}
const failed = results.filter(item => !item.ok).length
console.log()
console.log(failed === 0 ? '全部通过。' : `${failed} 项没过。`)

server.close()
process.exit(failed === 0 ? 0 : 1)
