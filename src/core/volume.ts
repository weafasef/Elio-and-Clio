import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 舞台上的音量。
 *
 * 0–1，存在 dataDir/volume.json。文件缺失或写坏按 100%。
 */

export const DEFAULT_VOLUME = 1

function volumeFile(dataDir: string): string {
  return join(dataDir, 'volume.json')
}

export function readVolume(dataDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(volumeFile(dataDir), 'utf8')) as { volume?: unknown }
    const value = typeof parsed.volume === 'number' ? parsed.volume : NaN
    if (Number.isFinite(value)) return Math.min(1, Math.max(0, value))
  } catch {
    // 没有或坏了，用默认
  }
  return DEFAULT_VOLUME
}

export function writeVolume(dataDir: string, volume: number): number {
  if (!Number.isFinite(volume)) throw new Error('音量必须是数字')
  const value = Math.min(1, Math.max(0, volume))
  mkdirSync(dataDir, { recursive: true })

  const target = volumeFile(dataDir)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ volume: value }, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
  return value
}
