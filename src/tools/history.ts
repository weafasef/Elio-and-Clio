import { registerTool } from '../registries/tools.ts'
import { compressHistory, readArchive } from '../core/history.ts'
import { shiftTraceHistoryCounts } from '../core/trace.ts'

/**
 * 历史压缩与回看。
 *
 *   history_compress  把一段历史换成一行摘要，原文进档案
 *   history_read      按档案编号把原文读回来
 */

const TIME = /^\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}$/
const STAMP = /^(\d{4}\/\d{2}\/\d{2})#(\d{4})$/

/** 一次最多返回多少字（再多就提示分段） */
const MAX_CHARS = 20_000

registerTool({
  name: 'history_compress',
  description: '把一段会话历史换成一行摘要，原文存进档案。历史太长、上下文快满的时候用它。',
  parameters: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description: '从哪一刻开始，格式 2026/10/21/00/00',
      },
      end: {
        type: 'string',
        description: '到哪一刻为止，格式 2026/10/21/00/40',
      },
      summary: {
        type: 'string',
        description: '这段历史留下了什么，自己写，一两句话',
      },
    },
    required: ['start', 'end', 'summary'],
  },
  run(args, ctx) {
    const start = String(args.start)
    const end = String(args.end)
    const summary = String(args.summary).trim()

    if (!TIME.test(start) || !TIME.test(end)) {
      throw new Error('时间要写成 2026/10/21/00/00 这样')
    }
    if (start > end) {
      throw new Error('开始时间不能晚于结束时间')
    }
    if (!summary) {
      throw new Error('摘要不能为空')
    }

    const result = compressHistory(ctx.dataDir, start, end, summary)
    shiftTraceHistoryCounts(ctx.dataDir, result.firstIndex, result.removed)

    return `${result.removed} 条 → 档案 ${result.stamp}`
  },
})

registerTool({
  name: 'history_read',
  description: '按档案编号把压缩掉的原文读回来。',
  parameters: {
    type: 'object',
    properties: {
      stamp: {
        type: 'string',
        description: '档案编号，格式 2026/10/21#0001',
      },
      range: {
        type: 'string',
        description: '只读一部分：+20 表示前 20%，-30 表示后 30%；不写就读整段',
      },
    },
    required: ['stamp'],
  },
  run(args, ctx) {
    const matched = STAMP.exec(String(args.stamp).trim())
    if (!matched) throw new Error('档案编号要写成 2026/10/21#0001 这样')

    const [, date, id] = matched
    const segment = readArchive(ctx.dataDir, date!, id!)
    if (!segment) throw new Error(`找不到档案 ${date}#${id}`)

    const all = [...segment.body]
    let body = segment.body
    let note = ''

    const range = typeof args.range === 'string' ? args.range.trim() : ''
    if (range) {
      const part = /^([+-])(\d{1,3})$/.exec(range)
      if (!part) throw new Error('范围要写成 +20 或 -30 这样')

      const percent = Math.min(Number(part[2]), 100)
      const count = Math.max(1, Math.floor(all.length * percent / 100))
      body = part[1] === '+' ? all.slice(0, count).join('') : all.slice(-count).join('')
      note = `（${part[1] === '+' ? '前' : '后'} ${percent}%，共 ${all.length} 字）`
    }

    if ([...body].length > MAX_CHARS) {
      const kept = [...body].slice(0, MAX_CHARS).join('')
      return `档案 ${date}#${id}${note}\n\n${kept}\n\n（还有 ${all.length - MAX_CHARS} 字，用 range 分段看）`
    }

    return `档案 ${date}#${id}${note}\n范围：${segment.range}\n摘要：${segment.summary}\n\n${body}`
  },
})
