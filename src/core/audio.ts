import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 从 TTS 音频里算响度包络。
 *
 * 用系统自带的 afconvert 解码成单声道 16k PCM，再按 50ms 一帧算 RMS。
 * 不依赖 ffmpeg/sox，也不额外调用网络。
 */
export type LoudnessEnvelope = {
  /** 0–1 的响度，50ms 一帧 */
  values: number[]
  /** 每秒帧数 */
  rate: number
}

const SAMPLE_RATE = 16_000
const WINDOW_MS = 50
const RATE = Math.round(1000 / WINDOW_MS)
const NOISE_FLOOR = 0.02

export function analyzeLoudness(path: string): LoudnessEnvelope {
  const dir = mkdtempSync(join(tmpdir(), 'eh-loudness-'))
  const wavPath = join(dir, 'voice.wav')

  try {
    execFileSync(
      'afconvert',
      ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', path, wavPath],
      { stdio: 'ignore' },
    )

    const pcm = readPcm16Mono(readFileSync(wavPath))
    if (!pcm || pcm.samples.length === 0) return { values: [], rate: RATE }

    const window = Math.max(1, Math.round(pcm.sampleRate * WINDOW_MS / 1000))
    const raw: number[] = []
    for (let start = 0; start + window <= pcm.samples.length; start += window) {
      let sum = 0
      for (let i = start; i < start + window; i++) {
        const sample = pcm.samples[i]! / 32768
        sum += sample * sample
      }
      raw.push(Math.sqrt(sum / window))
    }
    if (raw.length === 0) return { values: [], rate: RATE }

    const peak = Math.max(...raw)
    if (!Number.isFinite(peak) || peak < 0.005) return { values: [], rate: RATE }

    const values = raw.map(value => {
      const normalized = Math.max(0, (value / peak - NOISE_FLOOR) / (1 - NOISE_FLOOR))
      return Number(Math.min(1, normalized).toFixed(3))
    })

    return { values, rate: RATE }
  } catch {
    return { values: [], rate: RATE }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Pcm16Mono = {
  samples: Int16Array
  sampleRate: number
}

function readPcm16Mono(buffer: Buffer): Pcm16Mono | null {
  if (buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null

  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 0
  let dataOffset = -1
  let dataSize = 0

  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ' && size >= 16) {
      format = buffer.readUInt16LE(body)
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, buffer.length - body)
      break
    }

    offset = body + size + (size % 2)
  }

  if (format !== 1 || channels !== 1 || bits !== 16 || dataOffset < 0 || dataSize < 2) {
    return null
  }

  const count = Math.floor(dataSize / 2)
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    samples[i] = buffer.readInt16LE(dataOffset + i * 2)
  }

  return { samples, sampleRate }
}
