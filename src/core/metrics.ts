import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 模型调用的运行统计。
 *
 * 每成功一次记一条：首 token 用时、输出 token、生成耗时、速度。
 * 存成 dataDir/metrics.json，重启后平均不清零；删掉就重新统计。
 */

export type CallStats = {
  /** 发请求到第一个字/工具参数到达；没有首 token 则为 null */
  firstTokenMs: number | null
  /** 整个请求耗时 */
  totalMs: number
  /** 输出 token 数；服务端没给则为 null */
  completionTokens: number | null
}

type StoredMetrics = {
  calls: number
  firstTokenCount: number
  firstTokenMsSum: number
  completionTokensSum: number
  decodeMsSum: number
  last: {
    firstTokenMs: number | null
    speed: number | null
    at: string
  } | null
}

export type MetricsSnapshot = {
  lastFirstTokenMs: number | null
  avgFirstTokenMs: number | null
  lastSpeed: number | null
  avgSpeed: number | null
}

function metricsPath(dataDir: string): string {
  return join(dataDir, 'metrics.json')
}

function emptyMetrics(): StoredMetrics {
  return {
    calls: 0,
    firstTokenCount: 0,
    firstTokenMsSum: 0,
    completionTokensSum: 0,
    decodeMsSum: 0,
    last: null,
  }
}

function readStored(dataDir: string): StoredMetrics {
  try {
    const parsed = JSON.parse(readFileSync(metricsPath(dataDir), 'utf8')) as Partial<StoredMetrics>
    const number = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0

    const last = parsed.last
    return {
      calls: number(parsed.calls),
      firstTokenCount: number(parsed.firstTokenCount),
      firstTokenMsSum: number(parsed.firstTokenMsSum),
      completionTokensSum: number(parsed.completionTokensSum),
      decodeMsSum: number(parsed.decodeMsSum),
      last: last && typeof last === 'object'
        ? {
            firstTokenMs: typeof last.firstTokenMs === 'number' ? last.firstTokenMs : null,
            speed: typeof last.speed === 'number' ? last.speed : null,
            at: typeof last.at === 'string' ? last.at : '',
          }
        : null,
    }
  } catch {
    // 文件不存在或写坏了，当成空统计
    return emptyMetrics()
  }
}

function writeStored(dataDir: string, metrics: StoredMetrics): void {
  try {
    const path = metricsPath(dataDir)
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(metrics, null, 2) + '\n', 'utf8')
    renameSync(temp, path)
  } catch {
    // 统计失败不影响对话
  }
}

/** 记一次成功的模型调用 */
export function recordCall(dataDir: string, call: CallStats): void {
  const stored = readStored(dataDir)
  stored.calls += 1

  const first = call.firstTokenMs
  if (first !== null && Number.isFinite(first) && first >= 0) {
    stored.firstTokenCount += 1
    stored.firstTokenMsSum += first
  }

  const completion = call.completionTokens
  let speed: number | null = null
  if (
    first !== null && Number.isFinite(first) && first >= 0 &&
    completion !== null && completion > 0 &&
    call.totalMs > first
  ) {
    const decodeMs = call.totalMs - first
    speed = completion / (decodeMs / 1000)
    stored.completionTokensSum += completion
    stored.decodeMsSum += decodeMs
  }

  stored.last = {
    firstTokenMs: first,
    speed,
    at: new Date().toISOString(),
  }

  writeStored(dataDir, stored)
}

/** 给感知缓存读的汇总 */
export function readMetrics(dataDir: string): MetricsSnapshot {
  const stored = readStored(dataDir)
  return {
    lastFirstTokenMs: stored.last?.firstTokenMs ?? null,
    avgFirstTokenMs: stored.firstTokenCount > 0
      ? stored.firstTokenMsSum / stored.firstTokenCount
      : null,
    lastSpeed: stored.last?.speed ?? null,
    avgSpeed: stored.decodeMsSum > 0
      ? stored.completionTokensSum / (stored.decodeMsSum / 1000)
      : null,
  }
}

export function formatFirstToken(metrics: MetricsSnapshot): string {
  if (metrics.lastFirstTokenMs === null && metrics.avgFirstTokenMs === null) return '无'
  return `${formatSeconds(metrics.lastFirstTokenMs)}（平均 ${formatSeconds(metrics.avgFirstTokenMs)}）`
}

export function formatTokenSpeed(metrics: MetricsSnapshot): string {
  if (metrics.lastSpeed === null && metrics.avgSpeed === null) return '无'
  return `${formatSpeed(metrics.lastSpeed)}（平均 ${formatSpeed(metrics.avgSpeed)}）`
}

function formatSeconds(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? '无' : `${(ms / 1000).toFixed(1)} 秒`
}

function formatSpeed(speed: number | null): string {
  return speed === null || !Number.isFinite(speed) ? '无' : `${Math.round(speed)} tok/s`
}
