import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTool } from '../registries/tools.ts'
import { loadConfig, type TtsConfig } from '../config.ts'
import { analyzeLoudness } from '../core/audio.ts'
import { finishSpeech, queueSpeech, startSpeech } from '../core/speech.ts'
import { readVolume } from '../core/volume.ts'

/**
 * 说话：把一句话交给 Fish Audio 合成，然后在本机播放。
 *
 * - 合成完才返回，所以出错她能看见
 * - 播放排队，一条念完再念下一条
 * - 请求走 curl，方便带 HTTP 代理（Node 自带 fetch 不认环境变量代理）
 */

const MAX_CHARS = 1000
const KEEP_FILES = 30

/** 只留汉字、字母、数字和空格，标点只留 ，。？！、 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[^\p{Script=Han}A-Za-z0-9\s，。？！、]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function ttsDir(dataDir: string): string {
  return join(dataDir, 'tts')
}

function curlConfig(config: TtsConfig, bodyPath: string, outputPath: string): string {
  const lines = [
    'silent',
    'show-error',
    'max-time = 120',
    `url = "${config.serverUrl.replace(/\/+$/, '')}/v1/tts"`,
    'request = "POST"',
    `output = "${outputPath}"`,
    'header = "Content-Type: application/json"',
    `header = "Authorization: Bearer ${config.apiKey}"`,
  ]
  if (config.model) lines.push(`header = "model: ${config.model}"`)
  if (config.proxyUrl) lines.push(`proxy = "${config.proxyUrl}"`)
  lines.push(`data-binary = "@${bodyPath}"`)
  return lines.join('\n') + '\n'
}

async function synthesize(text: string, config: TtsConfig, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const bodyPath = join(dir, `body-${stamp}.json`)
  const configPath = join(dir, `curl-${stamp}.conf`)
  const outputPath = join(dir, `say-${stamp}.mp3`)

  const body = {
    text,
    format: config.format ?? 'mp3',
    latency: config.latency ?? 'normal',
    ...(config.referenceId ? { reference_id: config.referenceId } : {}),
    ...(config.model ? { model: config.model } : {}),
  }

  writeFileSync(bodyPath, JSON.stringify(body), { mode: 0o600 })
  writeFileSync(configPath, curlConfig(config, bodyPath, outputPath), { mode: 0o600 })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('curl', ['-K', configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''

      child.stderr.on('data', chunk => {
        stderr += String(chunk)
      })
      child.on('error', error => reject(new Error(`起不了 curl：${error.message}`)))
      child.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`Fish Audio 请求失败（curl ${code}）：${stderr.trim().slice(0, 300)}`))
      })
    })
  } finally {
    try { unlinkSync(bodyPath) } catch { /* 已经没了 */ }
    try { unlinkSync(configPath) } catch { /* 已经没了 */ }
  }

  let size = 0
  try {
    size = statSync(outputPath).size
  } catch {
    size = 0
  }
  if (size === 0) throw new Error('Fish Audio 返回了空音频')

  return outputPath
}

/** 用 afinfo 读 mp3 时长；失败就按字数估一个 */
function probeDuration(path: string, text: string): number {
  try {
    const info = execFileSync('afinfo', [path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const matched = /estimated duration:\s*([\d.]+)\s*sec/i.exec(info)
    if (matched) {
      const ms = Number(matched[1]) * 1000
      if (Number.isFinite(ms) && ms > 0) return Math.round(ms)
    }
  } catch {
    // 读不到就按字数估
  }
  return Math.max(800, Math.round([...text].length * 180))
}

function play(path: string, volume: number): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('afplay', ['-v', String(volume), path], { stdio: 'ignore' })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

function prune(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(name => name.startsWith('say-') && name.endsWith('.mp3'))
      .map(name => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)

    for (const file of files.slice(KEEP_FILES)) {
      try { unlinkSync(join(dir, file.name)) } catch { /* 忽略 */ }
    }
  } catch {
    /* 目录还没建，忽略 */
  }
}

type SayItem = {
  id: number
  text: string
  path: string
  dataDir: string
  dir: string
  durationMs: number
  envelope: number[]
  envelopeRate: number
}

const queue: SayItem[] = []
let nextId = 1
let pumping = false

/** 入队后串行播放；开始/结束时同步给感知缓存 */
function enqueue(
  text: string,
  path: string,
  dataDir: string,
  dir: string,
  durationMs: number,
  envelope: number[],
  envelopeRate: number,
): void {
  const item: SayItem = { id: nextId++, text, path, dataDir, dir, durationMs, envelope, envelopeRate }
  queue.push(item)
  queueSpeech(item.id, item.text, item.durationMs, item.envelope, item.envelopeRate)
  void pump().catch(() => undefined)
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true

  try {
    while (queue.length > 0) {
      const item = queue.shift()!
      const volume = readVolume(item.dataDir)
      startSpeech(item.id, item.text, item.durationMs, item.envelope, item.envelopeRate)
      try {
        await play(item.path, volume)
      } finally {
        finishSpeech(item.id)
        // 等整条队列播完再清理，避免删掉还没播的文件
        if (queue.length === 0) prune(item.dir)
      }
    }
  } finally {
    pumping = false
  }
}

registerTool({
  name: 'say',
  description:
    '对主人说一句话。会显示在网页里，同时用我的声音念出来。' +
    '话里只用逗号、句号、问号、感叹号、顿号这五种标点，其他符号一律不要。' +
    '一次最好只说一句，不要连着调用好几次；想等主人回应就定个 1、2 分钟的闹钟然后 sleep。' +
    '不想出声只写内心活动，不要调用它。' +
    '返回「成功」只表示工具执行成功，不是主人说的话。',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: `要说的话，最多 ${MAX_CHARS} 字`,
      },
    },
    required: ['text'],
  },
  async run(args, ctx) {
    const raw = typeof args.text === 'string' ? args.text.trim() : ''
    if (!raw) throw new Error('要说的内容不能为空')

    const text = cleanForSpeech(raw)
    if (!text) throw new Error('清理掉特殊符号后没有可念的内容')

    if ([...text].length > MAX_CHARS) {
      throw new Error(`一次最多 ${MAX_CHARS} 字，分几次说`)
    }

    const config = loadConfig().tts
    if (!config || !config.serverUrl || !config.apiKey) {
      throw new Error('没有配置语音（config.tts）')
    }

    const dir = ttsDir(ctx.dataDir)
    const path = await synthesize(text, config, dir)
    const durationMs = probeDuration(path, text)
    const { values: envelope, rate: envelopeRate } = analyzeLoudness(path)
    enqueue(text, path, ctx.dataDir, dir, durationMs, envelope, envelopeRate)

    return '成功'
  },
})
