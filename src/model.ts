import { loadConfig } from './config.ts'
import type { Config } from './config.ts'

// ─────────────────────────────── 类型 ───────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 发给模型的一条消息 */
export type Msg = { role: Role, content: string }

/** 工具定义（工具表里的一项） */
export type ToolSchema = {
  name: string
  description: string
  /** JSON Schema：说明参数长什么样 */
  parameters: Record<string, unknown>
}

/** 模型要求调用的一次工具 */
export type ToolCall = {
  id: string
  name: string
  /** 已经 JSON.parse 过的参数对象 */
  args: unknown
  /** 原始参数字符串（解析失败时用来排查） */
  rawArgs: string
}

export type Usage = {
  prompt: number
  completion: number
  total: number
  /** 有多少 prompt token 是命中缓存的（服务端给才有） */
  cached?: number
}

/** 服务端报的耗时/缓存数据，字段名由 llama-server 决定 */
export type Timings = Record<string, number>

export type StreamRequest = {
  /** 系统提示词（人格提示词） */
  system?: string
  messages: Msg[]
  tools?: ToolSchema[]
}

export type StreamCallbacks = {
  /** 每收到一小段文字就调用一次（网页用它实时显示） */
  onText?: (piece: string) => void
}

export type StreamResult = {
  text: string
  toolCalls: ToolCall[]
  finishReason: string
  usage?: Usage
  timings?: Timings
  ms: {
    /** 第一个字到达的耗时；没有文字则为 null */
    firstToken: number | null
    total: number
  }
  /** 试了几次（第 1 次就成功 = 1） */
  attempts: number
}

// ─────────────────────────────── 错误 ───────────────────────────────

/** 服务端返回非 2xx */
export class ModelHttpError extends Error {
  status: number
  body: string
  /** 服务端给的错误码，例如 CONTEXT_WINDOW_EXCEEDED */
  code?: string
  /** 上下文超限时，这次请求有多少 prompt token */
  nPromptTokens?: number

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = 'ModelHttpError'
    this.status = status
    this.body = body
    try {
      const json = JSON.parse(body)
      this.code = json.code ?? json.error?.code
      this.nPromptTokens = json.n_prompt_tokens ?? json.error?.n_prompt_tokens
    } catch {
      // body 不是 JSON，忽略
    }
  }
}

/** 工具参数碎片拼起来后不是合法 JSON */
export class ToolArgsError extends Error {
  toolName: string
  rawArgs: string

  constructor(toolName: string, rawArgs: string, cause: unknown) {
    super(`工具 ${toolName} 的参数不是合法 JSON：${String(cause)}`)
    this.name = 'ToolArgsError'
    this.toolName = toolName
    this.rawArgs = rawArgs
  }
}

/** 一段时间收不到数据 */
export class IdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`已经 ${ms} 毫秒没收到数据，掐断`)
    this.name = 'IdleTimeoutError'
  }
}

// ─────────────────────────────── 主函数 ───────────────────────────────

const RETRY_DELAYS = [0, 2_000, 5_000, 10_000]

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * 发一次请求，流式收完，返回结构化结果。
 *
 * - 4xx（除 429）不重试
 * - 连接失败 / 5xx / 429 会重试（间隔 2s、5s、10s）
 * - 每次 read() 超过 idleTimeoutMs 没有数据就掐断
 * - 外部可以用 signal 主动中止
 */
export async function streamChat(
  req: StreamRequest,
  cb: StreamCallbacks = {},
  opts: { config?: Config, signal?: AbortSignal, retries?: number } = {},
): Promise<StreamResult> {
  const config = opts.config ?? loadConfig()
  const maxAttempts = Math.max(1, opts.retries ?? config.maxRetries)

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await attemptOnce(config, req, cb, opts.signal)
      return { ...result, attempts: attempt }
    } catch (error) {
      lastError = error
      if (opts.signal?.aborted) throw error
      // 请求本身有问题（400、422…），重试没有意义
      if (error instanceof ModelHttpError && error.status < 500 && error.status !== 429) throw error
      if (attempt >= maxAttempts) throw error
      await sleep(RETRY_DELAYS[attempt] ?? 10_000)
    }
  }
  throw lastError
}

// ─────────────────────────────── 单次尝试 ───────────────────────────────

type OnceResult = Omit<StreamResult, 'attempts'>

async function attemptOnce(
  config: Config,
  req: StreamRequest,
  cb: StreamCallbacks,
  outerSignal?: AbortSignal,
): Promise<OnceResult> {
  const startedAt = Date.now()

  const payload = {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      ...req.messages,
    ],
    ...(req.tools?.length
      ? {
          tools: req.tools.map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  }

  // 自己的中止开关（用于空闲超时），和外部的合并
  const controller = new AbortController()
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ModelHttpError(res.status, text)
  }

  // 服务端没按流式回（一次性 JSON）：直接解析
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return parseWholeBody(await res.json(), startedAt)
  }

  return parseStream(res, config.idleTimeoutMs, controller, cb, startedAt)
}

// ─────────────────────────────── 流式解析 ───────────────────────────────

async function parseStream(
  res: Response,
  idleTimeoutMs: number,
  controller: AbortController,
  cb: StreamCallbacks,
  startedAt: number,
): Promise<OnceResult> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let text = ''
  let finishReason = ''
  let firstTokenAt: number | null = null
  let usage: Usage | undefined
  let timings: Timings | undefined

  // 流式里工具调用是一片片给的，按 index 分组累加
  const calls = new Map<number, { id: string, name: string, args: string }>()

  // 区分"我们自己因为空闲掐断"和"外部掐断"：
  // abort() 会先让 read() 抛 AbortError，抢在超时错误之前，所以要用这个标记兜回来
  let timedOut = false

  outer: while (true) {
    const { done, value } = await withIdleTimeout(
      reader.read(),
      idleTimeoutMs,
      () => {
        timedOut = true
        controller.abort()
      },
    ).catch((error: unknown) => {
      if (timedOut) throw new IdleTimeoutError(idleTimeoutMs)
      throw normalizeAbort(error, idleTimeoutMs)
    })

    if (done) break

    // 字节 → 文字。stream:true 让解码器记住"半个汉字"
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (!line || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue

      const data = line.slice(5).trim()
      if (data === '[DONE]') break outer

      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        continue // 不是完整 JSON 的行（极少见），跳过
      }

      if (json.usage) {
        usage = {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          total: json.usage.total_tokens ?? 0,
          cached: json.usage.prompt_tokens_details?.cached_tokens ?? json.usage.prompt_cache_hit_tokens,
        }
      }
      if (json.timings) timings = json.timings

      const choice = json.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (delta?.content) {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        text += delta.content
        cb.onText?.(delta.content)
      }

      for (const frag of delta?.tool_calls ?? []) {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        const index = frag.index ?? 0
        let call = calls.get(index)
        if (!call) {
          call = { id: '', name: '', args: '' }
          calls.set(index, call)
        }
        if (frag.id) call.id = frag.id
        if (frag.function?.name) call.name = frag.function.name
        if (frag.function?.arguments) call.args += frag.function.arguments // ← 累加，不能直接 parse
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }

  return {
    text,
    toolCalls: finalizeToolCalls(calls),
    finishReason,
    usage,
    timings,
    ms: {
      firstToken: firstTokenAt === null ? null : firstTokenAt - startedAt,
      total: Date.now() - startedAt,
    },
  }
}

/** 把累加好的参数字符串统一解析成对象 */
function finalizeToolCalls(
  calls: Map<number, { id: string, name: string, args: string }>,
): ToolCall[] {
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => {
      let args: unknown = {}
      if (call.args.trim()) {
        try {
          args = JSON.parse(call.args)
        } catch (error) {
          throw new ToolArgsError(call.name || `index ${index}`, call.args, error)
        }
      }
      return {
        id: call.id || `call_${index}`,
        name: call.name,
        args,
        rawArgs: call.args,
      }
    })
}

// ─────────────────────────────── 非流式兜底 ───────────────────────────────

function parseWholeBody(json: any, startedAt: number): OnceResult {
  const choice = json.choices?.[0]
  const message = choice?.message ?? {}
  const calls: Map<number, { id: string, name: string, args: string }> = new Map()

  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    calls.set(index, {
      id: call.id ?? '',
      name: call.function?.name ?? '',
      args: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
    })
  }

  return {
    text: message.content ?? '',
    toolCalls: finalizeToolCalls(calls),
    finishReason: choice?.finish_reason ?? '',
    usage: json.usage
      ? {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          total: json.usage.total_tokens ?? 0,
          cached: json.usage.prompt_tokens_details?.cached_tokens ?? json.usage.prompt_cache_hit_tokens,
        }
      : undefined,
    timings: json.timings,
    ms: { firstToken: 0, total: Date.now() - startedAt },
  }
}

// ─────────────────────────────── 小工具 ───────────────────────────────

/** 给一个 Promise 加"空闲超时"：超过 ms 没结果就调用 onTimeout 并抛错 */
async function withIdleTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new IdleTimeoutError(ms))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function normalizeAbort(error: unknown, idleTimeoutMs: number): unknown {
  if (error instanceof IdleTimeoutError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`请求被中止（可能是空闲超过 ${idleTimeoutMs} 毫秒）`)
  }
  return error
}
