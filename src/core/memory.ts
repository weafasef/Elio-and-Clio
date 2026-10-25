import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * 记忆文档。
 *
 *   skeleton.txt   一行一个 路径|可见
 *   content.md     `## 路径` + `- [确定|猜想] 正文`
 *   changes.jsonl  每次工具改完追加一条，只存改动过的段
 *   rev            当前版本号
 *   daily/         每天第一次改动前的完整快照，回放时当代替起点
 *
 * 结构和人格一样，但所有条目都必须带来源，空文档也渲染成
 * `【记忆文档】（空）`。
 */

export const MAX_MEMORY_TOKENS = 4000
export const MAX_FILE_TOKENS = 20000

export type Source = '确定' | '猜想'

export type MemoryEntry = {
  source: Source
  text: string
}

export type SkeletonLine = {
  path: string
  visible: boolean
}

export type MemoryNode = {
  name: string
  path: string
  visible: boolean
  entries: MemoryEntry[]
  children: MemoryNode[]
}

export type MemoryChange = {
  rev: number
  at: string
  tool: 'memory_edit' | 'memory_order' | 'sync'
  summary: string
  skeleton: string
  sections: Record<string, MemoryEntry[]>
}

type DailySnapshot = {
  date: string
  rev: number
  skeleton: string
  content: Record<string, MemoryEntry[]>
}

export type MemoryRender = {
  text: string
  rev: number
  tokens: number
}

export type MemoryState = {
  lines: SkeletonLine[]
  content: Map<string, MemoryEntry[]>
}

function memoryDir(dataDir: string): string {
  return join(dataDir, 'memory')
}

function dailyDir(dataDir: string): string {
  return join(memoryDir(dataDir), 'daily')
}

export function estimateTokens(text: string): number {
  return [...text].length
}

function splitPath(path: string): string[] {
  return path.split('/')
}

function parseSkeletonText(raw: string): SkeletonLine[] {
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
    lines.push({ path, visible })
  }

  return lines
}

export function readSkeletonLines(dataDir: string): SkeletonLine[] {
  try {
    return parseSkeletonText(readFileSync(join(memoryDir(dataDir), 'skeleton.txt'), 'utf8'))
  } catch {
    return []
  }
}

/** 只读带来源的条目；没有 [确定|猜想] 的纯文本行会忽略 */
export function readContent(dataDir: string): Map<string, MemoryEntry[]> {
  const map = new Map<string, MemoryEntry[]>()

  let raw: string
  try {
    raw = readFileSync(join(memoryDir(dataDir), 'content.md'), 'utf8')
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
    if (!sourced) continue
    const value = (sourced[2] ?? '').trim()
    if (value) map.get(current)!.push({ source: sourced[1] as Source, text: value })
  }

  return map
}

/** 补父段、去重、保证父段排在子段前面；内容里出现但骨架没有的段默认隐藏 */
export function normalizeLines(
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
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
    put(path, false)
  }

  return order.map(path => ({
    path,
    visible: visible.get(path) ?? false,
  }))
}

export function formatEntry(entry: MemoryEntry): string {
  return `- [${entry.source}] ${entry.text}`
}

export function buildTree(
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
): MemoryNode[] {
  const normalized = normalizeLines(lines, content)
  const nodes = new Map<string, MemoryNode>()
  const roots: MemoryNode[] = []

  for (const line of normalized) {
    const node: MemoryNode = {
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

/** 渲染记忆块。没有段时也保留标题和「（空）」。 */
export function renderFrom(
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
): string {
  const parts: string[] = []

  const walk = (node: MemoryNode, depth: number) => {
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

  if (parts.length === 0) return '【记忆文档】（空）'
  return ['【记忆文档】', ...parts].join('\n\n')
}

/** 每轮现读；返回渲染文本和当前版本号 */
export function renderMemory(dataDir: string): MemoryRender {
  const content = readContent(dataDir)
  const lines = normalizeLines(readSkeletonLines(dataDir), content)
  const text = renderFrom(lines, content)
  return {
    text,
    rev: readRev(dataDir),
    tokens: estimateTokens(text),
  }
}

export function serializeSkeleton(lines: SkeletonLine[]): string {
  return lines.length ? lines.map(line => `${line.path}|${line.visible ? 1 : 0}`).join('\n') + '\n' : ''
}

export function serializeContent(
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
): string {
  if (lines.length === 0) return ''
  const blocks = lines.map(line => {
    const entries = content.get(line.path) ?? []
    return [`## ${line.path}`, ...entries.map(formatEntry)].join('\n')
  })
  return blocks.join('\n\n') + '\n'
}

/** 两个文件一起换（先写 tmp 再 rename） */
export function writeMemoryFiles(
  dataDir: string,
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
): void {
  const dir = memoryDir(dataDir)
  mkdirSync(dir, { recursive: true })

  for (const [name, text] of [
    ['skeleton.txt', serializeSkeleton(lines)],
    ['content.md', serializeContent(lines, content)],
  ] as const) {
    const target = join(dir, name)
    const tmp = target + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, target)
  }
}

export function readRev(dataDir: string): number {
  try {
    const value = Number(readFileSync(join(memoryDir(dataDir), 'rev'), 'utf8').trim())
    if (Number.isInteger(value) && value >= 0) return value
  } catch {
    // 没有 rev 文件，从 changes 最后一条推
  }

  const changes = readChanges(dataDir)
  return changes.length > 0 ? changes[changes.length - 1]!.rev : 0
}

export function writeRev(dataDir: string, rev: number): void {
  const dir = memoryDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'rev')
  const tmp = target + '.tmp'
  writeFileSync(tmp, String(rev) + '\n', 'utf8')
  renameSync(tmp, target)
}

function changesFile(dataDir: string): string {
  return join(memoryDir(dataDir), 'changes.jsonl')
}

export function readChanges(dataDir: string): MemoryChange[] {
  let raw: string
  try {
    raw = readFileSync(changesFile(dataDir), 'utf8')
  } catch {
    return []
  }

  const changes: MemoryChange[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as MemoryChange
      if (Number.isInteger(parsed.rev) && parsed.rev >= 0) changes.push(parsed)
    } catch {
      // 坏行跳过
    }
  }

  return changes.sort((a, b) => a.rev - b.rev)
}

export function appendChange(dataDir: string, change: MemoryChange): void {
  const dir = memoryDir(dataDir)
  mkdirSync(dir, { recursive: true })
  appendFileSync(changesFile(dataDir), JSON.stringify(change) + '\n', 'utf8')
}

/** 本地日期，快照文件名用 */
export function dateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时间，change 记录用 */
export function memoryStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getHours())}/${pad(date.getMinutes())}`
}

function sectionsFromContent(content: Map<string, MemoryEntry[]>): Record<string, MemoryEntry[]> {
  const sections: Record<string, MemoryEntry[]> = {}
  for (const [path, entries] of content) {
    sections[path] = entries.map(entry => ({ source: entry.source, text: entry.text }))
  }
  return sections
}

function contentFromSections(sections: Record<string, MemoryEntry[]> | undefined): Map<string, MemoryEntry[]> {
  const content = new Map<string, MemoryEntry[]>()
  if (!sections) return content
  for (const [path, entries] of Object.entries(sections)) {
    if (!Array.isArray(entries)) continue
    content.set(path, entries
      .filter(entry => entry && (entry.source === '确定' || entry.source === '猜想') && typeof entry.text === 'string')
      .map(entry => ({ source: entry.source, text: entry.text })))
  }
  return content
}

function dailyFile(dataDir: string, date: string): string {
  return join(dailyDir(dataDir), `${date}.json`)
}

/**
 * 当天第一次改动前存一份完整快照。
 *
 * 已存在就不覆盖，这样一天只有一份，代表当天改动前的起点。
 */
export function ensureDailySnapshot(
  dataDir: string,
  rev: number,
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
  date = dateKey(),
): void {
  const file = dailyFile(dataDir, date)

  try {
    JSON.parse(readFileSync(file, 'utf8'))
    return
  } catch {
    // 不存在或坏了，重新写
  }

  const snapshot: DailySnapshot = {
    date,
    rev,
    skeleton: serializeSkeleton(lines),
    content: sectionsFromContent(content),
  }

  mkdirSync(dailyDir(dataDir), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(snapshot), 'utf8')
  renameSync(tmp, file)
}

function readDailySnapshots(dataDir: string): DailySnapshot[] {
  const snapshots: DailySnapshot[] = []
  let names: string[]
  try {
    names = readdirSync(dailyDir(dataDir))
  } catch {
    return snapshots
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dailyDir(dataDir), name), 'utf8')) as DailySnapshot
      if (Number.isInteger(parsed.rev) && parsed.rev >= 0) snapshots.push(parsed)
    } catch {
      // 坏快照跳过
    }
  }

  return snapshots.sort((a, b) => b.rev - a.rev)
}

function applyChange(
  state: { lines: SkeletonLine[]; content: Map<string, MemoryEntry[]> },
  change: MemoryChange,
): void {
  state.lines = parseSkeletonText(change.skeleton)

  for (const [path, entries] of Object.entries(change.sections ?? {})) {
    state.content.set(path, entries
      .filter(entry => entry && (entry.source === '确定' || entry.source === '猜想') && typeof entry.text === 'string')
      .map(entry => ({ source: entry.source, text: entry.text })))
  }

  const existing = new Set(state.lines.map(line => line.path))
  for (const path of [...state.content.keys()]) {
    if (!existing.has(path)) state.content.delete(path)
  }
}

/**
 * 回放到指定版本的原始状态。
 *
 * 先找 rev <= target 的最近一份每日快照，再只应用它之后的 changes。
 */
export function readMemoryStateAt(dataDir: string, targetRev: number): MemoryState {
  const target = Number.isFinite(targetRev) ? Math.max(0, Math.floor(targetRev)) : 0
  const snapshot = readDailySnapshots(dataDir).find(item => item.rev <= target)

  const state: MemoryState = {
    lines: snapshot ? parseSkeletonText(snapshot.skeleton) : [],
    content: snapshot ? contentFromSections(snapshot.content) : new Map(),
  }

  const baseRev = snapshot?.rev ?? 0
  for (const change of readChanges(dataDir)) {
    if (change.rev <= baseRev) continue
    if (change.rev > target) break
    applyChange(state, change)
  }

  return state
}

/** 回放到指定版本并渲染 */
export function renderMemoryAt(dataDir: string, targetRev: number): string {
  const state = readMemoryStateAt(dataDir, targetRev)
  return renderFrom(state.lines, state.content)
}

/**
 * 检测到有人直接改了 memory 文件时，补一条 sync 记录。
 *
 * 平时她只走工具，不会触发；手动改过之后，下一次工具写入前会先
 * 把当前状态记成一版，保证后面的 trace 还能回放。
 */
export function syncExternalChanges(
  dataDir: string,
  rev: number,
  lines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
): number {
  const currentLines = normalizeLines(lines, content)
  const expected = readMemoryStateAt(dataDir, rev)

  if (
    serializeSkeleton(currentLines) === serializeSkeleton(expected.lines) &&
    serializeContent(currentLines, content) === serializeContent(expected.lines, expected.content)
  ) {
    return rev
  }

  const next = rev + 1
  const existing = new Set(currentLines.map(line => line.path))
  const paths = new Set([
    ...currentLines.map(line => line.path),
    ...content.keys(),
    ...expected.lines.map(line => line.path),
    ...expected.content.keys(),
  ])

  const changed: string[] = []
  const sections: Record<string, MemoryEntry[]> = {}
  for (const path of paths) {
    const before = JSON.stringify(expected.content.get(path) ?? [])
    const after = JSON.stringify(content.get(path) ?? [])
    if (before === after) continue
    changed.push(path)
    if (existing.has(path)) {
      sections[path] = (content.get(path) ?? []).map(entry => ({ ...entry }))
    }
  }

  const detail = changed.slice(0, 6).join('、') + (changed.length > 6 ? '…' : '')
  appendChange(dataDir, {
    rev: next,
    at: memoryStamp(),
    tool: 'sync',
    summary: detail ? `同步外部改动：${detail}` : '同步外部改动：结构/可见性',
    skeleton: serializeSkeleton(currentLines),
    sections,
  })
  writeRev(dataDir, next)
  return next
}

/** 取一段版本区间的变化摘要，trace 里只存这个 */
export function summarizeChanges(dataDir: string, fromExclusive: number, toInclusive: number): string {
  return readChanges(dataDir)
    .filter(change => change.rev > fromExclusive && change.rev <= toInclusive)
    .map(change => change.summary)
    .filter(Boolean)
    .join('；')
}
