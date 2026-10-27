import { registerTool } from '../registries/tools.ts'
import {
  MAX_FILE_TOKENS,
  MAX_MEMORY_TOKENS,
  appendChange,
  buildTree,
  ensureDailySnapshot,
  estimateTokens,
  memoryStamp,
  normalizeLines,
  readContent,
  readRev,
  readSkeletonLines,
  renderFrom,
  serializeContent,
  serializeSkeleton,
  syncExternalChanges,
  writeMemoryFiles,
  writeRev,
  type MemoryEntry,
  type MemoryNode,
  type SkeletonLine,
  type Source,
} from '../core/memory.ts'

/**
 * 记忆文档 = 第二份人格。
 *
 * 段是一棵可以往下分的树：路径用 / 分层。
 * 可见的段每轮全文进 prompt；隐藏的段只留标题和条数，要看用 memory_read。
 * 所有条目都必须带 [确定] 或 [猜想]。
 */

function normalizePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('路径必须是字符串')
  const raw = value.trim()
  if (!raw) throw new Error('路径不能为空')
  if (/[\r\n|]/.test(raw)) throw new Error('路径里不能有换行或 |')

  const parts = raw.split('/').map(part => part.trim())
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`路径格式不对：${raw}`)
  }
  return parts.join('/')
}

function ensureOne(lines: SkeletonLine[], path: string, visible: boolean): void {
  if (lines.some(line => line.path === path)) return

  const cut = path.lastIndexOf('/')
  const parent = cut > 0 ? path.slice(0, cut) : null
  let index = lines.length

  if (parent) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const current = lines[i]!.path
      if (current === parent || current.startsWith(parent + '/')) {
        index = i + 1
        break
      }
    }
  }

  lines.splice(index, 0, { path, visible })
}

/** 新路径自动补父段；父段排在子段前面 */
function ensurePath(lines: SkeletonLine[], path: string, visible = false): void {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    ensureOne(lines, parts.slice(0, i).join('/'), false)
  }
  ensureOne(lines, path, visible)
}

function entriesOf(content: Map<string, MemoryEntry[]>, path: string): MemoryEntry[] {
  const existing = content.get(path)
  if (existing) return existing
  const fresh: MemoryEntry[] = []
  content.set(path, fresh)
  return fresh
}

function hasPath(lines: SkeletonLine[], content: Map<string, MemoryEntry[]>, path: string): boolean {
  return lines.some(line => line.path === path) || content.has(path)
}

function readSource(value: unknown): Source {
  if (value !== '确定' && value !== '猜想') {
    throw new Error('来源只能是「确定」或「猜想」')
  }
  return value
}

function oneLine(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  const text = value.trim()
  if (!text) throw new Error(`${label}不能为空`)
  if (/[\r\n]/.test(text)) throw new Error(`${label}里不能换行`)
  return text
}

/** 把「删除条目」的条号/原文转成 0 开始的索引 */
function pickEntryIndexes(
  entries: Array<{ text: string }>,
  selection: unknown,
  path: string,
): number[] {
  const picked: number[] = []

  if (typeof selection === 'number') {
    if (!Number.isInteger(selection)) throw new Error('删除条目的条号必须是整数')
    picked.push(selection)
  } else if (Array.isArray(selection)) {
    if (selection.length === 0) throw new Error('删除条目的条号数组不能为空')
    for (const item of selection) {
      if (typeof item !== 'number' || !Number.isInteger(item)) {
        throw new Error('删除条目的条号数组里只能是整数')
      }
      picked.push(item)
    }
  } else if (typeof selection === 'string') {
    const needle = selection.trim()
    if (!needle) throw new Error('删除条目的原文不能为空')
    const hits = entries
      .map((entry, index) => ({ entry, index }))
      .filter(item => item.entry.text === needle)
    if (hits.length === 0) throw new Error(`「${path}」里没有这一条：${needle}`)
    if (hits.length > 1) {
      const list = hits
        .slice(0, 10)
        .map(item => `${item.index + 1}. ${item.entry.text}`)
        .join('\n')
      throw new Error(`「${path}」里有 ${hits.length} 条完全相同，无法确定删哪一条：\n${list}`)
    }
    picked.push(hits[0]!.index + 1)
  } else {
    throw new Error('删除条目只能传条号、条号数组，或原文')
  }

  const unique = [...new Set(picked)]
  for (const number of unique) {
    if (number < 1 || number > entries.length) {
      throw new Error(`条号 ${number} 不存在；「${path}」现在共 ${entries.length} 条`)
    }
  }
  return unique.map(number => number - 1).sort((a, b) => a - b)
}

type Row = { path: string, visible: boolean, count: number, depth: number }

function rowsOf(nodes: MemoryNode[], depth = 0, rows: Row[] = []): Row[] {
  for (const node of nodes) {
    rows.push({ path: node.path, visible: node.visible, count: node.entries.length, depth })
    rowsOf(node.children, depth + 1, rows)
  }
  return rows
}

function summary(lines: SkeletonLine[], content: Map<string, MemoryEntry[]>): string {
  const rows = rowsOf(buildTree(lines, content))
  const body = rows.length
    ? rows.map(row => `${'  '.repeat(row.depth)}${row.path}  ${row.visible ? '可见' : '隐藏'}  ${row.count} 条`).join('\n')
    : '（空）'

  const total = rows.reduce((sum, row) => sum + row.count, 0)
  const fileTokens = estimateTokens(serializeContent(lines, content))
  const renderTokens = estimateTokens(renderFrom(lines, content))
  const hints = rows
    .filter(row => row.visible && row.count > 20)
    .map(row => `提示：「${row.path}」有 ${row.count} 条，可以拆成子段（memory_edit 的「移动」）`)

  return [
    body,
    '',
    `共 ${rows.length} 段，${total} 条；文件约 ${fileTokens} token，记忆块约 ${renderTokens} token`,
    ...hints,
  ].join('\n')
}

type MutableState = {
  lines: SkeletonLine[]
  content: Map<string, MemoryEntry[]>
}

function cloneState(state: MutableState): MutableState {
  return {
    lines: state.lines.map(line => ({ ...line })),
    content: new Map([...state.content].map(([path, entries]) => [
      path,
      entries.map(entry => ({ ...entry })),
    ])),
  }
}

/** trace 里只存一句，太长就截 */
function compactSummary(notes: string[]): string {
  const text = notes.filter(Boolean).join('；')
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

/**
 * 写盘、记版本、记变化。
 *
 * 顺序：当天快照 → 新文件 → changes.jsonl → rev。
 * 快照只存当天第一次改动前的状态，之后当天都靠 changes 回放。
 */
function commitMemory(
  dataDir: string,
  before: MutableState,
  finalLines: SkeletonLine[],
  content: Map<string, MemoryEntry[]>,
  touched: Set<string>,
  tool: 'memory_edit' | 'memory_order',
  notes: string[],
): void {
  const beforeSkeleton = serializeSkeleton(before.lines)
  const beforeContent = serializeContent(before.lines, before.content)
  const afterSkeleton = serializeSkeleton(finalLines)
  const afterContent = serializeContent(finalLines, content)

  if (beforeSkeleton === afterSkeleton && beforeContent === afterContent) return

  const rev = readRev(dataDir)
  ensureDailySnapshot(dataDir, rev, before.lines, before.content)

  const nextRev = rev + 1
  const existing = new Set(finalLines.map(line => line.path))
  const sections: Record<string, MemoryEntry[]> = {}
  for (const path of touched) {
    if (!existing.has(path)) continue
    sections[path] = (content.get(path) ?? []).map(entry => ({ ...entry }))
  }

  writeMemoryFiles(dataDir, finalLines, content)
  appendChange(dataDir, {
    rev: nextRev,
    at: memoryStamp(),
    tool,
    summary: compactSummary(notes),
    skeleton: afterSkeleton,
    sections,
  })
  writeRev(dataDir, nextRev)
}

registerTool({
  name: 'memory_edit',
  description:
    '改我给自己的长期记忆。一次可以改多条：加一条、改写一条、删一条、把条目移到子段、清空某段、删段。' +
    '路径用 / 分层，例如 读书/无职转生。新路径会自动补父段，默认隐藏。' +
    '所有条目都必须标来源，只能是「确定」或「猜想」。可见段每轮都会看到，隐藏段用 memory_read 查。',
  parameters: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: '要做的改动，一条一个对象',
        items: {
          type: 'object',
          properties: {
            路径: { type: 'string', description: '段的路径，例如 主人 或 读书/无职转生' },
            正文: { type: 'string', description: '一条记忆；空字符串表示清空该段，不要和改写、删除条目同时用' },
            改写: { type: 'string', description: '要替换的旧条目原文；正文不能为空；多条完全相同会报错' },
            删除条目: { description: '删掉某一（几）条：条号（整数，从 1 开始）、条号数组，或原文（必须完全一致；重复会报错）' },
            移动: { description: '条号（整数）、条号数组，或一段文字（唯一命中时才移动）' },
            到: { type: 'string', description: '移动的目标路径' },
            来源: { type: 'string', enum: ['确定', '猜想'] },
            删除: { type: 'boolean', description: 'true = 删掉整段（不是删一条）' },
            递归: { type: 'boolean', description: '删有子段的段时必须传 true' },
          },
          required: ['路径'],
        },
      },
    },
    required: ['edits'],
  },
  run(args, ctx) {
    const edits = args.edits
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits 要是非空数组')

    const content = readContent(ctx.dataDir)
    const lines = normalizeLines(readSkeletonLines(ctx.dataDir), content)
    syncExternalChanges(ctx.dataDir, readRev(ctx.dataDir), lines, content)
    const before = cloneState({ lines, content })
    const touched = new Set<string>()

    const notes: string[] = []

    for (const raw of edits) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('每一条改动都要是对象')
      }
      const edit = raw as Record<string, unknown>
      const path = normalizePath(edit.路径)

      // 删除整段
      if (edit.删除 === true) {
        const descendants = lines.filter(
          line => line.path === path || line.path.startsWith(path + '/'),
        )
        if (descendants.length === 0 && !content.has(path)) {
          throw new Error(`没有这一段：${path}`)
        }
        touched.add(path)

        const children = descendants.filter(line => line.path !== path)
        if (children.length > 0 && edit.递归 !== true) {
          const names = children.map(line => line.path).slice(0, 6).join(' / ')
          throw new Error(`${path} 下面还有 ${children.length} 个子段（${names}）。先删子段，或传 递归: true`)
        }

        const removed = new Set([path, ...descendants.map(line => line.path)])
        const count = [...removed].reduce(
          (sum, item) => sum + (content.get(item)?.length ?? 0),
          0,
        )

        for (let i = lines.length - 1; i >= 0; i--) {
          if (removed.has(lines[i]!.path)) lines.splice(i, 1)
        }
        for (const item of removed) content.delete(item)

        notes.push(`已删除：${path}${children.length > 0 ? `（含 ${children.length} 个子段）` : ''}，共 ${count} 条`)
        continue
      }

      // 删掉一（几）条，段本身保留
      if (edit.删除条目 !== undefined) {
        if (edit.正文 !== undefined || edit.改写 !== undefined || edit.移动 !== undefined) {
          throw new Error('「删除条目」不能和「正文」「改写」「移动」同时用')
        }

        const source = content.get(path)
        if (!source || source.length === 0) throw new Error(`「${path}」没有条目可删`)

        const indexes = pickEntryIndexes(source, edit.删除条目, path)
        const remove = new Set(indexes)
        content.set(path, source.filter((_, index) => !remove.has(index)))
        touched.add(path)
        notes.push(`删除了「${path}」的 ${indexes.length} 条`)
        continue
      }

      // 把条目移到另一个段
      if (edit.移动 !== undefined) {
        const target = normalizePath(edit.到)
        if (target === path) throw new Error('移动目标不能是自己')

        const source = content.get(path)
        if (!source || source.length === 0) throw new Error(`「${path}」没有条目可移动`)

        const moving = edit.移动
        const picked: number[] = []

        if (typeof moving === 'number') {
          if (!Number.isInteger(moving)) throw new Error('条号必须是整数')
          picked.push(moving)
        } else if (Array.isArray(moving)) {
          if (moving.length === 0) throw new Error('移动的条号数组不能为空')
          for (const item of moving) {
            if (typeof item !== 'number' || !Number.isInteger(item)) {
              throw new Error('条号数组里只能是整数')
            }
            picked.push(item)
          }
        } else if (typeof moving === 'string') {
          const needle = moving.trim()
          if (!needle) throw new Error('移动的文字不能为空')
          const hits = source
            .map((entry, index) => ({ entry, index }))
            .filter(item => item.entry.text.includes(needle))
          if (hits.length === 0) throw new Error(`「${path}」里没有包含「${needle}」的条目`)
          if (hits.length > 1) {
            const list = hits
              .slice(0, 10)
              .map(item => `${item.index + 1}. ${item.entry.text}`)
              .join('\n')
            throw new Error(`「${path}」里有 ${hits.length} 条包含「${needle}」，无法确定移哪一条：\n${list}`)
          }
          picked.push(hits[0]!.index + 1)
        } else {
          throw new Error('移动只能是条号、条号数组，或一段文字')
        }

        const unique = [...new Set(picked)]
        for (const number of unique) {
          if (number < 1 || number > source.length) {
            throw new Error(`条号 ${number} 不存在；「${path}」现在共 ${source.length} 条`)
          }
        }

        const indexes = unique.map(number => number - 1).sort((a, b) => a - b)
        const stay = source.filter((_, index) => !indexes.includes(index))
        const moved = indexes.map(index => source[index]!)

        ensurePath(lines, target, false)
        const destination = entriesOf(content, target)
        content.set(path, stay)
        destination.push(...moved)
        touched.add(path)
        touched.add(target)

        notes.push(`移动了 ${moved.length} 条：${path} → ${target}`)
        continue
      }

      // 清空 / 改写 / 加一条
      if (typeof edit.正文 !== 'string') throw new Error('每一条改动都要有「正文」')
      const body = edit.正文.trim()
      if (/[\r\n]/.test(body)) throw new Error('正文里不能换行')

      if (body === '') {
        if (edit.改写 !== undefined) {
          throw new Error('要删一条请用「删除条目」；「改写」的正文不能为空')
        }
        if (!hasPath(lines, content, path)) throw new Error(`没有这一段：${path}`)
        content.set(path, [])
        touched.add(path)
        notes.push(`清空了「${path}」`)
        continue
      }

      const source = readSource(edit.来源)

      if (edit.改写 !== undefined) {
        const old = oneLine(edit.改写, '改写')
        const list = entriesOf(content, path)
        const hits = list
          .map((entry, index) => ({ entry, index }))
          .filter(item => item.entry.text === old)

        if (hits.length === 0) throw new Error(`「${path}」里没有这一条：${old}`)
        if (hits.length > 1) {
          throw new Error(`「${path}」里有 ${hits.length} 条完全相同，无法确定改哪一条：${old}`)
        }

        list[hits[0]!.index] = { source, text: body }
        touched.add(path)
        notes.push(`改写了「${path}」的 1 条`)
        continue
      }

      ensurePath(lines, path, false)
      entriesOf(content, path).push({ source, text: body })
      touched.add(path)
      notes.push(`记了一条到「${path}」`)
    }

    const finalLines = normalizeLines(lines, content)
    const fileTokens = estimateTokens(serializeContent(finalLines, content))
    const renderTokens = estimateTokens(renderFrom(finalLines, content))

    if (fileTokens > MAX_FILE_TOKENS) {
      throw new Error(`文件会到 ${fileTokens} token，超过上限 ${MAX_FILE_TOKENS}。先合并或删掉一些。`)
    }
    if (renderTokens > MAX_MEMORY_TOKENS) {
      throw new Error(
        `记忆块会到 ${renderTokens} token，超过上限 ${MAX_MEMORY_TOKENS}。` +
        '把一些段设为隐藏，或删掉一些条目。',
      )
    }

    commitMemory(ctx.dataDir, before, finalLines, content, touched, 'memory_edit', notes)

    return [notes.join('\n'), '', summary(finalLines, content)].join('\n')
  },
})

registerTool({
  name: 'memory_order',
  description:
    '决定哪些记忆段每轮都载入上下文，以及它们的顺序。' +
    '可见列表里的段会被渲染；没列出的段只留标题和条数。' +
    '顺序列表可选，给了就必须列全所有路径。',
  parameters: {
    type: 'object',
    properties: {
      可见列表: {
        type: 'array',
        description: '每轮要载入的段路径；可以为空，表示全部隐藏',
        items: { type: 'string' },
      },
      顺序列表: {
        type: 'array',
        description: '可选；列全所有路径，父段必须排在子段前面',
        items: { type: 'string' },
      },
    },
    required: ['可见列表'],
  },
  run(args, ctx) {
    const visibleRaw = args.可见列表
    if (!Array.isArray(visibleRaw)) {
      throw new Error('可见列表要是数组')
    }

    const visible = visibleRaw.map(item => normalizePath(item))
    if (new Set(visible).size !== visible.length) throw new Error('可见列表里有重复路径')

    const content = readContent(ctx.dataDir)
    let lines = normalizeLines(readSkeletonLines(ctx.dataDir), content)
    syncExternalChanges(ctx.dataDir, readRev(ctx.dataDir), lines, content)
    const before = cloneState({ lines, content })
    const notes: string[] = []

    const existed = new Set(lines.map(line => line.path))
    for (const path of visible) {
      if (!existed.has(path)) throw new Error(`没有这一段：${path}`)
    }

    if (args.顺序列表 !== undefined) {
      if (!Array.isArray(args.顺序列表)) throw new Error('顺序列表要是数组')
      const order = args.顺序列表.map(item => normalizePath(item))
      if (new Set(order).size !== order.length) throw new Error('顺序列表里有重复路径')

      const wanted = new Set(order)
      const missing = lines.filter(line => !wanted.has(line.path))
      const extra = order.filter(path => !existed.has(path))
      if (missing.length > 0) throw new Error(`顺序列表少了这些段：${missing.map(line => line.path).join(' / ')}`)
      if (extra.length > 0) throw new Error(`顺序列表里有不存在的段：${extra.join(' / ')}`)

      const position = new Map(order.map((path, index) => [path, index]))
      for (const path of order) {
        const cut = path.lastIndexOf('/')
        if (cut < 0) continue
        const parent = path.slice(0, cut)
        if ((position.get(parent) ?? Infinity) > position.get(path)!) {
          throw new Error(`父段必须排在子段前面：${parent} 在 ${path} 后面`)
        }
      }

      lines = order.map(path => lines.find(line => line.path === path)!)
    }

    for (const line of lines) {
      line.visible = visible.includes(line.path)
    }
    notes.push(`可见 ${visible.length} 段${args.顺序列表 !== undefined ? '，顺序已更新' : ''}`)

    const renderTokens = estimateTokens(renderFrom(lines, content))
    if (renderTokens > MAX_MEMORY_TOKENS) {
      throw new Error(
        `记忆块会到 ${renderTokens} token，超过上限 ${MAX_MEMORY_TOKENS}。` +
        '少放几个可见段，或先把内容合并。',
      )
    }

    commitMemory(ctx.dataDir, before, lines, content, new Set(), 'memory_order', notes)
    return summary(lines, content)
  },
})

registerTool({
  name: 'memory_read',
  description:
    '分页读某个记忆段的全部条目，包括隐藏段。默认一次 20 条。',
  parameters: {
    type: 'object',
    properties: {
      路径: { type: 'string', description: '段路径，例如 读书/无职转生' },
      从第几条: { type: 'integer', description: '从第几条开始，默认 0' },
      几条: { type: 'integer', description: '一次读几条，默认 20，最多 100' },
    },
    required: ['路径'],
  },
  run(args, ctx) {
    const path = normalizePath(args.路径)
    const lines = readSkeletonLines(ctx.dataDir)
    const content = readContent(ctx.dataDir)

    if (!hasPath(lines, content, path)) throw new Error(`没有这一段：${path}`)

    const entries = content.get(path) ?? []
    const offset = args.从第几条 === undefined ? 0 : Number(args.从第几条)
    const limit = args.几条 === undefined ? 20 : Number(args.几条)

    if (!Number.isInteger(offset) || offset < 0) throw new Error('从第几条要是非负整数')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('几条要在 1–100 之间')

    if (entries.length === 0) return `${path}（共 0 条）\n（这一段没有条目）`

    const start = Math.min(offset, entries.length)
    const end = Math.min(start + limit, entries.length)

    if (start >= entries.length) {
      return `${path}（共 ${entries.length} 条）\n（从第 ${offset + 1} 条起没有）`
    }

    const rows = entries
      .slice(start, end)
      .map((entry, index) => `${start + index + 1}. ${entry.source ? `[${entry.source}] ` : ''}${entry.text}`)

    return [`${path}（第 ${start + 1}–${end} 条，共 ${entries.length} 条）`, ...rows].join('\n')
  },
})

registerTool({
  name: 'memory_list',
  description: '看整个记忆树：每段的路径、可见状态、条数。不返回正文。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const content = readContent(ctx.dataDir)
    const lines = normalizeLines(readSkeletonLines(ctx.dataDir), content)
    return summary(lines, content)
  },
})
