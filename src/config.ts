import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** eh 的配置。默认值写在代码里，可以被 ~/.eh/config.json 和环境变量覆盖。 */
export type Config = {
  /** 模型服务地址（OpenAI 兼容），例如 http://127.0.0.1:8096/v1 */
  baseUrl: string
  /** 服务端要 key 时才填 */
  apiKey?: string
  /** 模型名，要和 /v1/models 里的一致 */
  model: string
  /** 模型窗口大小（一个 slot 的） */
  contextWindow: number
  /** 这个实例的数据目录 */
  dataDir: string
  /** 网页端口 */
  port: number
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
  idleTimeoutMs: 60_000,
  maxRetries: 3,
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
  return {
    ...DEFAULTS,
    ...fromFile,
    baseUrl: process.env.EH_BASE_URL ?? fromFile.baseUrl ?? DEFAULTS.baseUrl,
    model: process.env.EH_MODEL ?? fromFile.model ?? DEFAULTS.model,
    apiKey: process.env.EH_API_KEY ?? fromFile.apiKey,
    port: envPort ? Number(envPort) : (fromFile.port ?? DEFAULTS.port),
  }
}
