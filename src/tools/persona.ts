import { registerTool } from '../registries/tools.ts'
import {
  MAX_FILE_TOKENS,
  MAX_PERSONA_TOKENS,
  REQUIRED,
  buildTree,
  estimateTokens,
  normalizeLines,
  readContent,
  readSkeletonLines,
  renderFrom,
  serializeContent,
  writePersona,
  type PersonaEntry,
  type PersonaNode,
  type SkeletonLine,
  type Source,
} from '../core/persona.ts'

/**
 * 人格 = 记忆。
 *
 * 段是一棵可以往下分的树：路径用 / 分层。
 * 可见的段每轮全文进 system；隐藏的段只留标题和条数，要看用 persona_read。
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

  lines.splice(index, 0, { path, visible: path === REQUIRED ? true : visible })
}

/** 新路径自动补父段；父段排在子段前面 */
function ensurePath(lines: SkeletonLine[], path: string, visible = false): void {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    ensureOne(lines, parts.slice(0, i).join('/'), false)
  }
  ensureOne(lines, path, visible)
}

function entriesOf(content: Map<string, PersonaEntry[]>, path: string): PersonaEntry[] {
  const existing = content.get(path)
  if (existing) return existing
  const fresh: PersonaEntry[] = []
  content.set(path, fresh)
  return fresh
}

function hasPath(lines: SkeletonLine[], content: Map<string, PersonaEntry[]>, path: string): boolean {
  return lines.some(line => line.path === path) || content.has(path)
}

function readSource(value: unknown, path: string): Source | null {
  if (path === REQUIRED) return null
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

type Row = { path: string, visible: boolean, count: number, depth: number }

function rowsOf(nodes: PersonaNode[], depth = 0, rows: Row[] = []): Row[] {
  for (const node of nodes) {
    rows.push({ path: node.path, visible: node.visible, count: node.entries.length, depth })
    rowsOf(node.children, depth + 1, rows)
  }
  return rows
}

function summary(lines: SkeletonLine[], content: Map<string, PersonaEntry[]>): string {
  const rows = rowsOf(buildTree(lines, content))
  const body = rows
    .map(row => `${'  '.repeat(row.depth)}${row.path}  ${row.visible ? '可见' : '隐藏'}  ${row.count} 条`)
    .join('\n')

  const total = rows.reduce((sum, row) => sum + row.count, 0)
  const fileTokens = estimateTokens(serializeContent(lines, content))
  const renderTokens = estimateTokens(renderFrom(lines, content))
  const hints = rows
    .filter(row => row.visible && row.count > 20)
    .map(row => `提示：「${row.path}」有 ${row.count} 条，可以拆成子段（persona_edit 的「移动」）`)

  return [
    body,
    '',
    `共 ${rows.length} 段，${total} 条；文件约 ${fileTokens} token，人格块约 ${renderTokens} token`,
    ...hints,
  ].join('\n')
}

registerTool({
  name: 'persona_edit',
  description:
    '改我的人格记忆。一次可以改多条：加一条、改写一条、把条目移到子段、清空某段、删段。' +
    '路径用 / 分层，例如 读书/无职转生。新路径会自动补父段，默认隐藏。' +
    '来源只能是「确定」或「猜想」。',
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
            正文: { type: 'string', description: '一条记忆；空字符串表示清空该段' },
            改写: { type: 'string', description: '要替换的旧条目原文；多条完全相同会报错' },
            移动: { description: '条号（整数）、条号数组，或一段文字（唯一命中时才移动）' },
            到: { type: 'string', description: '移动的目标路径' },
            来源: { type: 'string', enum: ['确定', '猜想'] },
            删除: { type: 'boolean', description: 'true = 删掉这一段' },
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
    ensurePath(lines, REQUIRED, true)

    const notes: string[] = []

    for (const raw of edits) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('每一条改动都要是对象')
      }
      const edit = raw as Record<string, unknown>
      const path = normalizePath(edit.路径)

      // 删除整段
      if (edit.删除 === true) {
        if (path === REQUIRED) throw new Error(`「${REQUIRED}」不能删`)

        const descendants = lines.filter(
          line => line.path === path || line.path.startsWith(path + '/'),
        )
        if (descendants.length === 0 && !content.has(path)) {
          throw new Error(`没有这一段：${path}`)
        }

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

        notes.push(`移动了 ${moved.length} 条：${path} → ${target}`)
        continue
      }

      // 清空 / 改写 / 加一条
      if (typeof edit.正文 !== 'string') throw new Error('每一条改动都要有「正文」')
      const body = edit.正文.trim()
      if (/[\r\n]/.test(body)) throw new Error('正文里不能换行')

      if (body === '') {
        if (!hasPath(lines, content, path)) throw new Error(`没有这一段：${path}`)
        content.set(path, [])
        notes.push(`清空了「${path}」`)
        continue
      }

      const source = readSource(edit.来源, path)

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
        notes.push(`改写了「${path}」的 1 条`)
        continue
      }

      ensurePath(lines, path, false)
      entriesOf(content, path).push({ source, text: body })
      notes.push(`记了一条到「${path}」`)
    }

    const finalLines = normalizeLines(lines, content)
    const fileTokens = estimateTokens(serializeContent(finalLines, content))
    const renderTokens = estimateTokens(renderFrom(finalLines, content))

    if (fileTokens > MAX_FILE_TOKENS) {
      throw new Error(`文件会到 ${fileTokens} token，超过上限 ${MAX_FILE_TOKENS}。先合并或删掉一些。`)
    }
    if (renderTokens > MAX_PERSONA_TOKENS) {
      throw new Error(
        `人格块会到 ${renderTokens} token，超过上限 ${MAX_PERSONA_TOKENS}。` +
        '把一些段设为隐藏，或删掉一些条目。',
      )
    }

    writePersona(ctx.dataDir, finalLines, content)

    return [notes.join('\n'), '', summary(finalLines, content)].join('\n')
  },
})

registerTool({
  name: 'persona_order',
  description:
    '决定哪些人格段每轮都载入上下文，以及它们的顺序。' +
    '可见列表里的段会被渲染；没列出的段只留标题和条数。' +
    '顺序列表可选，给了就必须列全所有路径。',
  parameters: {
    type: 'object',
    properties: {
      可见列表: {
        type: 'array',
        description: '每轮要载入的段路径；必须包含「工具使用事项」',
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
    if (!Array.isArray(visibleRaw) || visibleRaw.length === 0) {
      throw new Error('可见列表要是非空数组')
    }

    const visible = visibleRaw.map(item => normalizePath(item))
    if (new Set(visible).size !== visible.length) throw new Error('可见列表里有重复路径')

    const base = readSkeletonLines(ctx.dataDir)
    const content = readContent(ctx.dataDir)
    let lines = normalizeLines(base, content)

    const existed = new Set(lines.map(line => line.path))
    for (const path of visible) {
      if (!existed.has(path)) throw new Error(`没有这一段：${path}`)
    }
    if (!visible.includes(REQUIRED)) throw new Error(`「${REQUIRED}」必须在可见列表里`)

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
      line.visible = line.path === REQUIRED || visible.includes(line.path)
    }

    const renderTokens = estimateTokens(renderFrom(lines, content))
    if (renderTokens > MAX_PERSONA_TOKENS) {
      throw new Error(
        `人格块会到 ${renderTokens} token，超过上限 ${MAX_PERSONA_TOKENS}。` +
        '少放几个可见段，或先把内容合并。',
      )
    }

    writePersona(ctx.dataDir, lines, content)
    return summary(lines, content)
  },
})

registerTool({
  name: 'persona_read',
  description:
    '分页读某个人格段的全部条目，包括隐藏段。默认一次 20 条。',
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
  name: 'persona_list',
  description: '看整个人格树：每段的路径、可见状态、条数。不返回正文。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const lines = normalizeLines(readSkeletonLines(ctx.dataDir), readContent(ctx.dataDir))
    const content = readContent(ctx.dataDir)
    return summary(lines, content)
  },
})
