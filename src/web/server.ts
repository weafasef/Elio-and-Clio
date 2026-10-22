import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendHistory, nextStep, readHistory, renderEntries } from '../core/history.ts'
import { findTrace } from '../core/trace.ts'
import { runStep } from '../core/loop.ts'
import { dueAlarms, nextAlarmText, readAlarms, removeAlarms } from '../tools/alarms.ts'
import type { Config } from '../config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_FILE = join(HERE, 'ui.html')

export type ServerHandle = {
  /** 关掉服务器 */
  close: () => Promise<void>
}

/**
 * 起网页服务（只监听 127.0.0.1）。
 *
 *   GET  /          页面
 *   GET  /history   全部历史（JSON）
 *   GET  /events    SSE：state / text / tool / loop / done
 *   POST /say       主人说一句（进队列，等当前这步结束再唤醒）
 */
export function startServer(config: Config): ServerHandle {
  const clients = new Set<ServerResponse>()
  /** 待唤醒的内容。外界消息和闹钟响都进这里，一条一步。 */
  const queue: Array<{ src: '外界消息' | '工具返回', text: string }> = []
  let busy = false
  let state: 'idle' | 'running' = 'idle'
  /** 下一个闹钟的定时器 */
  let timer: NodeJS.Timeout | undefined

  const send = (res: ServerResponse, event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const broadcast = (event: unknown) => {
    for (const client of clients) send(client, event)
  }

  const setState = (next: 'idle' | 'running') => {
    state = next
    broadcast({ type: 'state', state })
  }

  /** 按最近的一个闹钟重新排定时器（已过点的 200ms 后立刻响） */
  const schedule = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }

    const next = readAlarms(config.dataDir)[0]
    if (!next) return

    // "2026-10-20T15:30:05" 不带时区 → 按本地时间解析
    const delay = new Date(next.at).getTime() - Date.now()
    timer = setTimeout(() => void fire(), Math.max(delay, 200))
  }

  /** 到点：删掉闹钟 → 写进队列 → 唤醒 → 排下一个 */
  const fire = () => {
    timer = undefined
    const due = dueAlarms(config.dataDir)
    if (due.length > 0) {
      removeAlarms(config.dataDir, due.map(alarm => alarm.id))
      for (const alarm of due) {
        queue.push({ src: '工具返回', text: alarm.text || `闹钟响了（#${alarm.id}）` })
      }
      broadcast({ type: 'alarm', count: due.length })
      void kick()
    }
    schedule()
  }

  /** 把队列里的消息一次性放进历史，然后跑一步 */
  const kick = async () => {
    if (busy) return
    busy = true
    setState('running')

    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, queue.length)
        const stepId = nextStep(config.dataDir)
        // 一批里只要有人说话，就算「外界消息」把她叫醒的
        const wakeSource = batch.some(item => item.src === '外界消息') ? '外界消息' : '工具返回'
        for (const item of batch) {
          appendHistory(config.dataDir, item.src, item.text, { step: stepId })
        }
        broadcast({ type: 'history' })

        await runStep(config, {
          stepId,
          wakeSource,
          // 感知缓存里的 {{alarm}}：每轮现算
          perception: () => ({ alarm: nextAlarmText(config.dataDir) }),
          // 每一轮开始前把队列递进去（主人说的话、到点的闹钟）
          takeQueued: () => {
            const items = queue.splice(0, queue.length)
            if (items.length > 0) broadcast({ type: 'history' })
            return items
          },
          onText: piece => broadcast({ type: 'text', piece }),
          onLoopStart: loop => {
            broadcast({ type: 'loop', loop })
            // 她刚定完的闹钟，下一轮就挂上定时器
            schedule()
          },
          onToolCall: name => broadcast({ type: 'tool', name }),
        })
        broadcast({ type: 'done' })
      }
    } catch (error) {
      broadcast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      busy = false
      setState('idle')
      schedule()
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end('服务器出错：' + (error instanceof Error ? error.message : String(error)))
    })
  })

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    // 页面
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html: string
      try {
        html = readFileSync(UI_FILE, 'utf8')
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('找不到 ui.html')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // 全部历史
    if (req.method === 'GET' && path === '/history') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(readHistory(config.dataDir)))
      return
    }

    // 某一次的请求 + 响应
    if (req.method === 'GET' && path === '/trace') {
      const step = Number(url.searchParams.get('step'))
      const loop = Number(url.searchParams.get('loop'))
      const record = Number.isFinite(step) && Number.isFinite(loop)
        ? findTrace(config.dataDir, step, loop)
        : null

      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '没有这条记录' }))
        return
      }

      // 重建当时的 messages：历史按条数取，感知缓存用存下来的
      const entries = readHistory(config.dataDir).slice(0, record.historyCount)
      const historyText = renderEntries(entries)
      const messages: Array<{ role: 'user', content: string }> = []
      if (historyText) messages.push({ role: 'user', content: historyText })
      messages.push({ role: 'user', content: record.perception })

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        t: record.t,
        step: record.step,
        loop: record.loop,
        system: record.system,
        tools: record.tools,
        messages,
        response: record.response,
        historyCount: record.historyCount,
        // 历史被压缩过、条数不够时提示一下
        historyShort: entries.length < record.historyCount,
      }))
      return
    }

    // SSE
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      send(res, { type: 'state', state })
      req.on('close', () => clients.delete(res))
      return
    }

    // 主人说一句
    if (req.method === 'POST' && path === '/say') {
      const body = await readBody(req)
      let text = ''
      try {
        const parsed = JSON.parse(body) as { text?: unknown }
        if (typeof parsed.text === 'string') text = parsed.text.trim()
      } catch {
        // 下面统一报错
      }
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'text 不能为空' }))
        return
      }

      queue.push({ src: '外界消息', text })
      void kick()

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ queued: true, running: busy }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }

  // 立刻开始监听（必须在 return 之前，不然执行不到）
  server.listen(config.port, '127.0.0.1')
  // 重启后把还没响的闹钟接着排上（已过点的会立刻响）
  schedule()

  return {
    close: () => new Promise<void>(resolve => {
      if (timer) clearTimeout(timer)
      for (const client of clients) client.end()
      clients.clear()
      server.close(() => resolve())
    }),
  }
}

/** 读请求体（限 1 MB） */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1_000_000) throw new Error('请求体太大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
