import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AsrConfig } from '../config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'worker.py')
const START_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 120_000

export type AsrResult = {
  text: string
  /** 音频时长（模型侧算的） */
  durationMs?: number
  /** 模型推理耗时 */
  elapsedMs?: number
}

type Pending = {
  resolve: (result: AsrResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type WorkerMessage = {
  ready?: boolean
  id?: number
  text?: string
  error?: string
  durationMs?: number
  elapsedMs?: number
}

/**
 * 管理一个常驻的 Python ASR worker。
 *
 * - 第一次识别时才启动，模型只加载一次
 * - 请求串行处理，避免同时抢 MLX
 * - 空闲一段时间后结束进程，释放模型内存
 * - 进程异常退出时，下一次请求会自动重新启动
 */
export class AsrService {
  private config: AsrConfig
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | undefined
  private stderr = ''
  private closed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(config: AsrConfig) {
    this.config = config
  }

  /** 串行转写一段 16k 单声道 WAV */
  transcribe(wav: Buffer): Promise<AsrResult> {
    const run = this.queue.then(() => this.transcribeNow(wav))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearIdle()
    const child = this.child
    this.child = null
    this.ready = false
    this.failAll(new Error('ASR 已关闭'))
    if (child) {
      try {
        child.stdin.end()
      } catch {
        // 已经退出了
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出了
      }
    }
    await this.starting?.catch(() => undefined)
  }

  private async transcribeNow(wav: Buffer): Promise<AsrResult> {
    if (this.closed) throw new Error('ASR 已关闭')
    if (!existsSync(this.config.python)) {
      throw new Error(`找不到 ASR Python：${this.config.python}`)
    }
    if (!existsSync(WORKER)) {
      throw new Error(`找不到 ASR worker：${WORKER}`)
    }

    const dir = await mkdtemp(join(tmpdir(), 'eh-asr-'))
    const path = join(dir, 'input.wav')
    try {
      await writeFile(path, wav)
      this.clearIdle()
      await this.ensureWorker()
      return await this.request(path)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.closed) throw new Error('ASR 已关闭')
    if (this.child && this.ready) return
    if (this.starting) return this.starting

    this.starting = this.startWorker()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      this.stderr = ''

      const child = spawn(this.config.python, [WORKER], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          HF_HUB_OFFLINE: '1',
          EH_ASR_MODEL: this.config.model,
          EH_ASR_LANGUAGE: this.config.language,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      this.ready = false

      const failStart = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        reject(error)
      }

      const startTimer = setTimeout(() => {
        failStart(new Error('ASR 模型加载超时'))
        this.stopWorker()
      }, START_TIMEOUT_MS)

      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line) continue

          let message: WorkerMessage
          try {
            message = JSON.parse(line) as WorkerMessage
          } catch {
            this.stderr = (this.stderr + '\n' + line).slice(-8000)
            continue
          }

          if (message.ready === true) {
            if (settled) continue
            settled = true
            clearTimeout(startTimer)
            this.ready = true
            resolve()
            continue
          }

          if (message.ready === false) {
            const error = new Error(message.error || 'ASR 模型加载失败')
            failStart(error)
            this.stopWorker()
            continue
          }

          if (typeof message.id === 'number') {
            this.finishRequest(message)
          }
        }
      })

      child.stderr.on('data', (chunk: unknown) => {
        this.stderr = (this.stderr + String(chunk)).slice(-8000)
      })

      child.on('error', (error: Error) => {
        const wrapped = new Error(`起不了 ASR worker：${error.message}`)
        failStart(wrapped)
        if (this.child === child) {
          this.child = null
          this.ready = false
        }
        this.failAll(wrapped)
      })

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = this.stderr.trim()
        const error = new Error(
          `ASR worker 退出（${signal ?? code}）${detail ? `：${detail.slice(-500)}` : ''}`,
        )
        failStart(error)
        if (this.child === child) {
          this.child = null
          this.ready = false
          this.clearIdle()
        }
        this.failAll(error)
      })
    })
  }

  private request(path: string): Promise<AsrResult> {
    const child = this.child
    if (!child || !this.ready) {
      return Promise.reject(new Error('ASR worker 还没准备好'))
    }

    this.clearIdle()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.stopWorker()
        reject(new Error('ASR 请求超时'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        child.stdin.write(JSON.stringify({
          id,
          path,
          hotwords: this.config.hotwords,
        }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private finishRequest(message: WorkerMessage): void {
    const id = message.id
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(id)

    if (typeof message.error === 'string' && message.error) {
      pending.reject(new Error(message.error))
      return
    }

    pending.resolve({
      text: typeof message.text === 'string' ? message.text.trim() : '',
      ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}),
      ...(typeof message.elapsedMs === 'number' ? { elapsedMs: message.elapsedMs } : {}),
    })
    this.touchIdle()
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private touchIdle(): void {
    this.clearIdle()
    if (this.config.idleUnloadMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.stopWorker()
    }, this.config.idleUnloadMs)
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  private stopWorker(): void {
    const child = this.child
    this.child = null
    this.ready = false
    this.clearIdle()
    if (!child) return

    try {
      child.stdin.end()
    } catch {
      // 已经退出了
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出了
      }
    }, 500)
    killTimer.unref()
    child.once('exit', () => clearTimeout(killTimer))
    this.failAll(new Error('ASR worker 已停止'))
  }
}
