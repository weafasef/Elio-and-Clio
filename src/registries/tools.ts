import type { ToolSchema } from '../model.ts'

/** 工具执行时能拿到的东西。以后要加就直接往这里加字段，工具签名不用变。 */
export type ToolContext = {
  /** 这个实例的数据目录，例如 ~/.eh/individuals/elio */
  dataDir: string
}

/**
 * 一个工具。
 *
 * - name / description / parameters：给模型看的部分（会变成请求里的 tools）
 * - run：真正干活的部分，只有我们这边调用
 */
export type Tool = {
  name: string
  description: string
  /** JSON Schema，说明参数长什么样 */
  parameters: Record<string, unknown>
  /** 返回一段文字，就是会话历史里「工具返回」那一行的内容 */
  run: (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>
}

const registry = new Map<string, Tool>()

/** 登记一个工具。重名直接报错（启动时就能发现，不用等到运行时）。 */
export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) {
    throw new Error(`工具名重复：${tool.name}`)
  }
  registry.set(tool.name, tool)
}

/** 给模型的工具表（只要名字、说明、参数格式） */
export function listToolSchemas(): ToolSchema[] {
  return [...registry.values()].map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** 已经登记了哪些工具 */
export function listToolNames(): string[] {
  return [...registry.keys()]
}

/** 某个工具在 schema 里声明的参数名，按声明顺序（排版历史时要用） */
export function getToolParameterKeys(name: string): string[] {
  const tool = registry.get(name)
  if (!tool) return []
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties
  return properties ? Object.keys(properties) : []
}

/**
 * 按工具的参数 schema 严格校验。
 *
 * 不合格就报错，不替模型"修"参数 —— 让她自己看到错误后重来。
 * 多余字段不拦（模型偶尔会多带 reason 之类的，拦了会反复重试）。
 */
function validateArgs(schema: Record<string, unknown>, args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return `参数应该是一个对象，实际是 ${describeValueType(args)}`
  }

  const { required = [], properties = {} } = schema as {
    required?: string[]
    properties?: Record<string, { type?: string }>
  }
  const record = args as Record<string, unknown>

  for (const key of required) {
    if (!(key in record)) return `缺少必需参数「${key}」`
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!(key in record)) continue
    const expected = property?.type
    if (!expected) continue
    if (!matchesType(record[key], expected)) {
      return `参数「${key}」应该是 ${expected}，实际是 ${describeValueType(record[key])}`
    }
  }

  return null
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    default: return true
  }
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 按名字执行一个工具。
 *
 * 三种情况都返回一段文字，不往外抛异常 —— 让她自己在会话历史里看到「错误：…」，
 * 然后决定下一步怎么做。
 */
export async function runTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const tool = registry.get(name)
  if (!tool) {
    return `错误：没有这个工具「${name}」。可用的有：${listToolNames().join(' / ') || '（一个都没有）'}`
  }

  const invalid = validateArgs(tool.parameters, args)
  if (invalid) {
    return `错误：参数不符合格式：${invalid}`
  }

  try {
    const result = await tool.run(args as Record<string, unknown>, ctx)
    return typeof result === 'string' && result.length > 0 ? result : '（无输出）'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `错误：${message}`
  }
}
