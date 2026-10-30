import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 语音合成（Fish Audio） */
export type TtsConfig = {
  serverUrl: string
  apiKey: string
  referenceId?: string
  model?: string
  format?: string
  latency?: string
  proxyUrl?: string
}

/** 本地语音识别（Qwen3-ASR / MLX） */
export type AsrConfig = {
  /** 独立 venv 里的 Python */
  python: string
  /** MLX 模型名或本地路径 */
  model: string
  /** Qwen3-ASR 用的语言名，例如 Chinese；auto 表示自动识别 */
  language: string
  /** 专有名词热词 */
  hotwords: string[]
  /** 空闲多久后释放 ASR 模型进程（毫秒） */
  idleUnloadMs: number
  /** 单次上传最多多少字节 */
  maxAudioBytes: number
}

/** eh 的配置。默认值写在代码里，可以被 ~/.eh/config.json 和环境变量覆盖。 */
export type Config = {
  /** 模型服务地址（OpenAI 兼容），例如 http://127.0.0.1:8096/v1 */
  baseUrl: string
  /** 服务端要 key 时才填 */
  apiKey?: string
  /** 模型名，要和 /v1/models 里的一致 */
  model: string
  /** 额外的请求头（例如 OpenCode Go 的 User-Agent / x-opencode-session） */
  headers?: Record<string, string>
  /** 模型窗口大小（一个 slot 的） */
  contextWindow: number
  /** 这个实例的数据目录 */
  dataDir: string
  /** 网页端口 */
  port: number
  /** 记忆库地址（Hindsight），例如 http://127.0.0.1:8888 */
  memoryUrl: string
  /** 记忆库里的 bank */
  memoryBank: string
  /** next 工具读的书（按 ===== NNN 标题 ===== 切章） */
  bookFile?: string
  /** 语音合成；不配就不出声 */
  tts?: TtsConfig
  /** 本地语音识别 */
  asr: AsrConfig
  /** 流式传输时，多久收不到数据就掐断（毫秒） */
  idleTimeoutMs: number
  /** 连接类错误最多试几次 */
  maxRetries: number
}

const DEFAULTS: Config = {
  baseUrl: 'http://127.0.0.1:8096/v1',
  model: 'qwen3.5-27b-abl',
  contextWindow: 131072,
  dataDir: join(homedir(), '.eh', 'individuals', 'elio'),
  port: 8099,
  memoryUrl: 'http://127.0.0.1:8888',
  memoryBank: 'elio',
  idleTimeoutMs: 60_000,
  maxRetries: 3,
  asr: {
    python: join(homedir(), '.venvs', 'qwen3-asr', 'bin', 'python'),
    model: 'mlx-community/Qwen3-ASR-1.7B-4bit',
    language: 'Chinese',
    hotwords: ['Elio', 'Clio', 'EH'],
    /** 0 = 常驻；改成毫秒数就是空闲后释放 */
    idleUnloadMs: 0,
    maxAudioBytes: 20_000_000,
  },
}

/**
 * 读配置。
 * 优先级：默认值 < ~/.eh/config.json < 环境变量（EH_BASE_URL / EH_MODEL / EH_PORT / EH_CONFIG）
 */
export function loadConfig(): Config {
  const file = process.env.EH_CONFIG ?? join(homedir(), '.eh', 'config.json')
  let fromFile: Partial<Config> = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>
    } catch (error) {
      throw new Error(`配置文件不是合法 JSON：${file}\n${String(error)}`)
    }
  }

  const envPort = process.env.EH_PORT
  const asr = { ...DEFAULTS.asr, ...(fromFile.asr ?? {}) }
  return {
    ...DEFAULTS,
    ...fromFile,
    baseUrl: process.env.EH_BASE_URL ?? fromFile.baseUrl ?? DEFAULTS.baseUrl,
    model: process.env.EH_MODEL ?? fromFile.model ?? DEFAULTS.model,
    apiKey: process.env.EH_API_KEY ?? fromFile.apiKey,
    port: envPort ? Number(envPort) : (fromFile.port ?? DEFAULTS.port),
    memoryUrl: process.env.EH_MEMORY_URL ?? fromFile.memoryUrl ?? DEFAULTS.memoryUrl,
    memoryBank: process.env.EH_MEMORY_BANK ?? fromFile.memoryBank ?? DEFAULTS.memoryBank,
    bookFile: process.env.EH_BOOK_FILE ?? fromFile.bookFile,
    asr: {
      ...asr,
      python: process.env.EH_ASR_PYTHON ?? asr.python,
      model: process.env.EH_ASR_MODEL ?? asr.model,
    },
  }
}
