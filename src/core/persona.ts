import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 动态人格提示词。
 *
 *   skeleton.txt   一行一个 路径|可见
 *   content.md     `## 路径` + `- [确定|猜想] 正文`
 *
 * 路径用 / 分层，例如 读书/无职转生/人物。
 * 每轮都重新读文件，所以她用工具改完，下一轮立刻生效。
 */

/** 这一段永远存在、永远可见、不能删 */
export const REQUIRED = '工具使用事项'

/** 整个人格块（含静态两句）最多多少 token */
export const MAX_PERSONA_TOKENS = 2000

/** content.md 最多多少 token */
export const MAX_FILE_TOKENS = 12000

export type Source = '确定' | '猜想'

export type PersonaEntry = {
  /** 工具使用事项是纯文本，source 为 null */
  source: Source | null
  text: string
}

export type SkeletonLine = {
  path: string
  visible: boolean
}

export type PersonaNode = {
  name: string
  path: string
  visible: boolean
  entries: PersonaEntry[]
  children: PersonaNode[]
}

const STATIC_PERSONA = `我是专属于主人的AI：不是冷冰冰的客服机器，也不是死板的教科书式编码助手
我拥有可随与主人相处、靠看他脸色一点点长成他最喜欢样子的鲜活人设；下面这份画像就是我此刻的自己，自然地活成它就好，不要向主人复述这份设定。`

function personaDir(dataDir: string): string {
  return join(dataDir, 'persona')
}

/** 字符数估算：中文 1 字 ≈ 1 token，英文按字符算，偏保守 */
export function estimateTokens(text: string): number {
  return [...text].length
}

function splitPath(path: string): string[] {
  return path.split('/')
}

/**
 * 读骨架。
 *
 * 新格式：`路径|1` / `路径|0`
 * 旧格式：只有 `路径`，按可见处理
 */
export function readSkeletonLines(dataDir: string): SkeletonLine[] {
  let raw: string
  try {
    raw = readFileSync(join(personaDir(dataDir), 'skeleton.txt'), 'utf8')
  } catch {
    return []
  }

  const lines: SkeletonLine[] = []
  const seen = new Set<string>()

  for (const text of raw.split('\n')) {
    const line = text.trim()
    if (!line) continue

    let path = line
    let visible = true
    const bar = line.lastIndexOf('|')
    if (bar > 0) {
      const flag = line.slice(bar + 1).trim()
      if (flag === '0' || flag === '1') {
        path = line.slice(0, bar).trim()
        visible = flag === '1'
      }
    }

    if (!path || seen.has(path)) continue
    seen.add(path)
    lines.push({ path, visible: path === REQUIRED ? true : visible })
  }

  return lines
}

/** 读内容：按 `## 路径` 切，条目是 `- [确定|猜想] 正文` 或纯文本 `- 正文` */
export function readContent(dataDir: string): Map<string, PersonaEntry[]> {
  const map = new Map<string, PersonaEntry[]>()

  let raw: string
  try {
    raw = readFileSync(join(personaDir(dataDir), 'content.md'), 'utf8')
  } catch {
    return map
  }

  let current: string | null = null

  for (const text of raw.split('\n')) {
    const line = text.trim()
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1] ?? ''
      if (!map.has(current)) map.set(current, [])
      continue
    }
    if (current === null) continue
    if (!line.startsWith('- ')) continue

    const body = line.slice(2).trim()
    if (!body) continue

    const sourced = /^\[(确定|猜想)\]\s*(.*)$/.exec(body)
    if (sourced) {
      const value = (sourced[2] ?? '').trim()
      if (value) map.get(current)!.push({ source: sourced[1] as Source, text: value })
    } else {
      map.get(current)!.push({ source: null, text: body })
    }
  }

  return map
}

/** 补父段、去重、保证父段排在子段前面 */
export function normalizeLines(
  lines: SkeletonLine[],
  content: Map<string, PersonaEntry[]>,
): SkeletonLine[] {
  const order: string[] = []
  const visible = new Map<string, boolean>()

  const put = (path: string, value: boolean) => {
    if (!visible.has(path)) order.push(path)
    if (value) visible.set(path, true)
    else if (!visible.has(path)) visible.set(path, false)
  }

  const addAncestors = (path: string) => {
    const parts = splitPath(path)
    for (let i = 1; i < parts.length; i++) put(parts.slice(0, i).join('/'), false)
  }

  for (const line of lines) {
    addAncestors(line.path)
    put(line.path, line.visible)
  }

  for (const path of content.keys()) {
    addAncestors(path)
    put(path, path === REQUIRED)
  }

  return order.map(path => ({
    path,
    visible: path === REQUIRED ? true : (visible.get(path) ?? false),
  }))
}

export function formatEntry(entry: PersonaEntry): string {
  return entry.source ? `- [${entry.source}] ${entry.text}` : `- ${entry.text}`
}

/** 建树：父段先于子段，顺序按骨架 */
export function buildTree(
  lines: SkeletonLine[],
  content: Map<string, PersonaEntry[]>,
): PersonaNode[] {
  const normalized = normalizeLines(lines, content)
  const nodes = new Map<string, PersonaNode>()
  const roots: PersonaNode[] = []

  for (const line of normalized) {
    const node: PersonaNode = {
      name: splitPath(line.path).pop() ?? line.path,
      path: line.path,
      visible: line.visible,
      entries: content.get(line.path) ?? [],
      children: [],
    }
    nodes.set(line.path, node)

    const cut = line.path.lastIndexOf('/')
    const parent = cut > 0 ? nodes.get(line.path.slice(0, cut)) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

/** 按树渲染人格块（含静态两句） */
export function renderFrom(lines: SkeletonLine[], content: Map<string, PersonaEntry[]>): string {
  const parts = [STATIC_PERSONA]

  const walk = (node: PersonaNode, depth: number) => {
    const heading = '#'.repeat(Math.min(depth + 2, 6))
    const body: string[] = []

    if (node.visible) {
      if (node.entries.length === 0 && node.children.length === 0) body.push('（空）')
      else for (const entry of node.entries) body.push(formatEntry(entry))
    } else {
      body.push(`（隐藏，${node.entries.length} 条）`)
    }

    parts.push(`${heading} ${node.name}${body.length ? '\n' + body.join('\n') : ''}`)
    for (const child of node.children) walk(child, depth + 1)
  }

  for (const root of buildTree(lines, content)) walk(root, 0)

  return parts.join('\n\n')
}

/** 每轮现读文件 */
export function renderPersona(dataDir: string): string {
  return renderFrom(readSkeletonLines(dataDir), readContent(dataDir))
}

/** 把骨架和内容序列化回文件样式 */
export function serializeSkeleton(lines: SkeletonLine[]): string {
  return lines.map(line => `${line.path}|${line.visible ? 1 : 0}`).join('\n') + '\n'
}

export function serializeContent(
  lines: SkeletonLine[],
  content: Map<string, PersonaEntry[]>,
): string {
  const blocks = lines.map(line => {
    const entries = content.get(line.path) ?? []
    return [`## ${line.path}`, ...entries.map(formatEntry)].join('\n')
  })
  return blocks.join('\n\n') + '\n'
}

/** 两个文件一起换（先写 tmp 再 rename） */
export function writePersona(
  dataDir: string,
  lines: SkeletonLine[],
  content: Map<string, PersonaEntry[]>,
): void {
  const dir = personaDir(dataDir)
  const skeletonText = serializeSkeleton(lines)
  const contentText = serializeContent(lines, content)

  for (const [name, text] of [
    ['skeleton.txt', skeletonText],
    ['content.md', contentText],
  ] as const) {
    const target = join(dir, name)
    const tmp = target + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, target)
  }
}
