import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendHistory, deleteHistoryLoop, nextStep, readHistory, renderEntries } from '../core/history.ts'
import type { EntryInput } from '../core/history.ts'
import { findTrace } from '../core/trace.ts'
import {
  buildTree,
  normalizeLines,
  readContent,
  readSkeletonLines,
  renderMemory,
  renderMemoryAt,
  type MemoryNode,
} from '../core/memory.ts'
import { runStep } from '../core/loop.ts'
import { AsrService } from '../asr/service.ts'
import { readVolume, writeVolume } from '../core/volume.ts'
import { speechSnapshot, subscribeSpeech } from '../core/speech.ts'
import { dueAlarms, nextAlarmText, readAlarms, removeAlarms } from '../tools/alarms.ts'
import type { Config } from '../config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_FILE = join(HERE, 'ui.html')
const STAGE_FILE = join(HERE, 'stage.html')
const VOICE_FILE = join(HERE, 'voice.js')
const ELIO_FILE = join(HERE, '..', '..', 'assets', 'Elio.jpg')
const ELIO_PNG_FILE = join(HERE, '..', '..', 'assets', 'Elio.png')

type MemoryViewRow = {
  path: string
  depth: number
  visible: boolean
  count: number
  entries: Array<{ source: string, text: string }>
}

/** 把记忆树压成网页好渲染的列表；隐藏段也保留正文，只在界面上标注 */
function flattenMemory(nodes: MemoryNode[], depth = 0, rows: MemoryViewRow[] = []): MemoryViewRow[] {
  for (const node of nodes) {
    rows.push({
      path: node.path,
      depth,
      visible: node.visible,
      count: node.entries.length,
      entries: node.entries.map(entry => ({ source: entry.source, text: entry.text })),
    })
    flattenMemory(node.children, depth + 1, rows)
  }
  return rows
}

export type ServerHandle = {
  /** 关掉服务器 */
  close: () => Promise<void>
}

/**
 * 起网页服务（只监听 127.0.0.1）。
 *
 *   GET  /          页面
 *   GET  /history   全部历史（JSON）
 *   GET  /memory    当前记忆树（JSON，含显示/隐藏）
 *   GET  /events    SSE：state / text / tool / loop / done
 *   POST /say       主人说一句（进队列，等当前这步结束再唤醒）
 */
export function startServer(config: Config): ServerHandle {
  const clients = new Set<ServerResponse>()
  /** 待唤醒的内容。外界消息和闹钟响都进这里，一条一步。 */
  const queue: Array<{ src: '外界消息' | '工具返回', text: string, input?: EntryInput }> = []
  const asr = new AsrService(config.asr)
  let busy = false
  let state: 'idle' | 'running' = 'idle'
  /** 当前这一步的中止开关（网页上的「停止」） */
  let abort: AbortController | undefined
  /** 下一个闹钟的定时器 */
  let timer: NodeJS.Timeout | undefined

  const send = (res: ServerResponse, event: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      clients.delete(res)
    }
  }

  const broadcast = (event: unknown) => {
    for (const client of [...clients]) send(client, event)
  }

  // 语音开始/结束时推给舞台；
  const unsubscribeSpeech = subscribeSpeech(event => {
    broadcast({
      ...event,
      type: event.type === 'start' ? 'speech-start' : 'speech-end',
    })
  })

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
    const controller = new AbortController()
    abort = controller
    setState('running')

    try {
      while (queue.length > 0) {
        if (controller.signal.aborted) break
        const batch = queue.splice(0, queue.length)
        const stepId = nextStep(config.dataDir)
        // 一批里只要有人说话，就算「外界消息」把她叫醒的
        const wakeSource = batch.some(item => item.src === '外界消息') ? '外界消息' : '工具返回'
        for (const item of batch) {
          appendHistory(config.dataDir, item.src, item.text, {
            step: stepId,
            ...(item.input ? { input: item.input } : {}),
          })
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
          // 每写一条历史就刷新页面，不用等整步结束
          onHistory: () => broadcast({ type: 'history' }),
          signal: controller.signal,
        })
        broadcast({ type: 'done' })
        if (controller.signal.aborted) break
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        broadcast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      busy = false
      abort = undefined
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

    // 舞台页
    if (req.method === 'GET' && path === '/stage') {
      let html: string
      try {
        html = readFileSync(STAGE_FILE, 'utf8')
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('找不到 stage.html')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    // 语音输入模块
    if (req.method === 'GET' && path === '/voice.js') {
      let js: string
      try {
        js = readFileSync(VOICE_FILE, 'utf8')
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('找不到 voice.js')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(js)
      return
    }

    // 舞台人物图
    if (req.method === 'GET' && (path === '/assets/elio.jpg' || path === '/assets/Elio.jpg')) {
      let image: Buffer
      try {
        image = readFileSync(ELIO_FILE)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('找不到 Elio.jpg')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache',
      })
      res.end(image)
      return
    }

    // 舞台人物图（透明版）
    if (req.method === 'GET' && (path === '/assets/elio.png' || path === '/assets/Elio.png')) {
      let image: Buffer
      try {
        image = readFileSync(ELIO_PNG_FILE)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('找不到 Elio.png')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
      })
      res.end(image)
      return
    }

    // 音量
    if (req.method === 'GET' && path === '/volume') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ volume: readVolume(config.dataDir) }))
      return
    }

    if (req.method === 'POST' && path === '/volume') {
      const body = await readBody(req)
      let volume: number | null = null
      try {
        const parsed = JSON.parse(body) as { volume?: unknown }
        if (typeof parsed.volume === 'number') volume = parsed.volume
      } catch {
        // 下面统一报错
      }

      if (volume === null || !Number.isFinite(volume) || volume < 0 || volume > 1) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'volume 要在 0–1 之间' }))
        return
      }

      const saved = writeVolume(config.dataDir, volume)
      broadcast({ type: 'volume', volume: saved })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, volume: saved }))
      return
    }

    // 当前运行状态：给桌宠判断“现在能不能安全重启窗口”
    if (req.method === 'GET' && path === '/status') {
      const speech = speechSnapshot()
      const nextAlarm = readAlarms(config.dataDir)[0]
      const nextAlarmAt = nextAlarm ? new Date(nextAlarm.at).getTime() : null
      const nextAlarmInMs = nextAlarmAt === null ? null : nextAlarmAt - Date.now()
      const sleeping =
        state === 'idle' &&
        !busy &&
        queue.length === 0 &&
        !speech.current &&
        speech.pending.length === 0

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({
        state,
        busy,
        sleeping,
        queued: queue.length,
        speech,
        nextAlarm: nextAlarm
          ? { id: nextAlarm.id, at: nextAlarm.at, text: nextAlarm.text }
          : null,
        nextAlarmInMs,
      }))
      return
    }

    // 全部历史
    if (req.method === 'GET' && path === '/history') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(readHistory(config.dataDir)))
      return
    }

    // 当前记忆树：显示/隐藏、条目和版本；隐藏段也返回正文供查看
    if (req.method === 'GET' && path === '/memory') {
      const content = readContent(config.dataDir)
      const lines = normalizeLines(readSkeletonLines(config.dataDir), content)
      const memory = renderMemory(config.dataDir)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({
        rev: memory.rev,
        tokens: memory.tokens,
        sections: flattenMemory(buildTree(lines, content)),
      }))
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

      // 重建当时的 messages：历史按条数取，记忆按版本回放，感知缓存用存下来的
      const entries = readHistory(config.dataDir).slice(0, record.historyCount)
      const historyText = renderEntries(entries)

      let memoryText: string | null = null
      let memoryShort = false
      if (record.memoryRev !== undefined) {
        try {
          memoryText = renderMemoryAt(config.dataDir, record.memoryRev)
        } catch {
          memoryText = '【记忆文档】（回放失败）'
          memoryShort = true
        }
      }

      const messages: Array<{ role: 'user', content: string }> = []
      if (historyText) messages.push({ role: 'user', content: historyText })
      if (memoryText !== null) messages.push({ role: 'user', content: memoryText })
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
        memoryRev: record.memoryRev,
        memoryTokens: record.memoryTokens,
        memoryChange: record.memoryChange,
        // 历史被压缩过、条数不够时提示一下
        historyShort: entries.length < record.historyCount,
        memoryShort,
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
      res.flushHeaders?.()
      res.write('retry: 3000\n\n')
      clients.add(res)
      send(res, {
        type: 'state',
        state,
        volume: readVolume(config.dataDir),
        speech: speechSnapshot(),
      })

      // 心跳：防止代理/系统把长连接当死连接掐掉
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(ping)
          clients.delete(res)
        }
      }, 15_000)

      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    // 停止当前这一步
    if (req.method === 'POST' && path === '/stop') {
      const stopped = !!busy && !!abort
      abort?.abort()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, stopped }))
      return
    }

    // 删除一个 loop 的全部历史（档案不动）
    if (req.method === 'POST' && path === '/history/delete') {
      if (busy) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '正在运行，先停止' }))
        return
      }

      const body = await readBody(req)
      let step = NaN
      let loop = NaN
      try {
        const parsed = JSON.parse(body) as { step?: unknown, loop?: unknown }
        if (typeof parsed.step === 'number') step = parsed.step
        if (typeof parsed.loop === 'number') loop = parsed.loop
      } catch {
        // 下面统一报错
      }

      if (!Number.isInteger(step) || !Number.isInteger(loop)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'step 和 loop 要是整数' }))
        return
      }

      const removed = deleteHistoryLoop(config.dataDir, step, loop)
      broadcast({ type: 'history' })

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, removed }))
      return
    }

    // 本地语音转写
    if (req.method === 'POST' && path === '/asr') {
      try {
        const audio = await readBodyBuffer(req, config.asr.maxAudioBytes)
        if (
          audio.length < 44 ||
          audio.toString('ascii', 0, 4) !== 'RIFF' ||
          audio.toString('ascii', 8, 12) !== 'WAVE'
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '需要 16k 单声道 WAV 音频' }))
          return
        }

        const result = await asr.transcribe(audio)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message.includes('请求体太大') ? 413 : 500
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    // 主人说一句
    if (req.method === 'POST' && path === '/say') {
      const body = await readBody(req)
      let text = ''
      let input: EntryInput = 'text'
      try {
        const parsed = JSON.parse(body) as { text?: unknown, input?: unknown }
        if (typeof parsed.text === 'string') text = parsed.text.trim()
        if (parsed.input === 'voice') input = 'voice'
      } catch {
        // 下面统一报错
      }
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'text 不能为空' }))
        return
      }

      queue.push({ src: '外界消息', text, input })
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
    close: async () => {
      unsubscribeSpeech()
      if (timer) clearTimeout(timer)
      for (const client of clients) client.end()
      clients.clear()
      await asr.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
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

/** 读二进制请求体（语音上传用） */
async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体太大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
