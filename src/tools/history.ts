import { registerTool } from '../registries/tools.ts'
import { compressHistory, compressHistoryByLines, readArchive } from '../core/history.ts'
import { shiftTraceHistoryCounts } from '../core/trace.ts'

/**
 * 历史压缩与回看。
 *
 *   history_compress  把一段历史换成一行摘要，原文进档案；可按时间或当前行号选
 *   history_read      按档案编号把原文读回来
 */

const TIME = /^\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}$/
const STAMP = /^(\d{4}\/\d{2}\/\d{2})#(\d{4})$/

/** 一次最多返回多少字（再多就提示分段） */
const MAX_CHARS = 20_000

registerTool({
  name: 'history_compress',
  description:
    '把一段会话历史换成一行摘要，原文存进档案。历史太长、上下文快满的时候用它。' +
    '可以按时间压缩，也可以按当前历史开头的 [n] 行号精确压缩；两种方式只能选一种。' +
    '同一轮回复最多成功压缩一次，压缩后行号会变化。',
  parameters: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description: '按时间压缩：从哪一刻开始，格式 2026/10/21/00/00',
      },
      end: {
        type: 'string',
        description: '按时间压缩：到哪一刻为止，格式 2026/10/21/00/40',
      },
      startLine: {
        type: 'integer',
        description: '按行号压缩：从当前历史第几行开始，从 1 开始',
      },
      endLine: {
        type: 'integer',
        description: '按行号压缩：到当前历史第几行为止，包含这一行',
      },
      summary: {
        type: 'string',
        description: '这段历史留下了什么，自己写，一两句话',
      },
    },
    required: ['summary'],
  },
  run(args, ctx) {
    const summary = String(args.summary).trim()
    if (!summary) throw new Error('摘要不能为空')

    const hasTime = args.start !== undefined || args.end !== undefined
    const hasLines = args.startLine !== undefined || args.endLine !== undefined

    if (hasTime && hasLines) {
      throw new Error('时间范围和行号范围只能选一种')
    }
    if (!hasTime && !hasLines) {
      throw new Error('要指定时间范围（start/end）或行号范围（startLine/endLine）')
    }

    let result: { removed: number, stamp: string, firstIndex: number }

    if (hasTime) {
      const start = String(args.start ?? '')
      const end = String(args.end ?? '')
      if (!TIME.test(start) || !TIME.test(end)) {
        throw new Error('时间要写成 2026/10/21/00/00 这样')
      }
      if (start > end) {
        throw new Error('开始时间不能晚于结束时间')
      }
      result = compressHistory(ctx.dataDir, start, end, summary)
    } else {
      const startLine = Number(args.startLine)
      const endLine = Number(args.endLine)
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        throw new Error('行号必须是整数')
      }
      result = compressHistoryByLines(ctx.dataDir, startLine, endLine, summary)
    }

    shiftTraceHistoryCounts(ctx.dataDir, result.firstIndex, result.removed)

    return `${result.removed} 条 → 档案 ${result.stamp}（行号已变化，下一轮重新看）`
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
        description: '只读一部分：+20 前 20%，-30 后 30%，35-55 从 35% 读到 55%；不写就读整段',
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
      const suffix = /^([+-])(\d{1,3})$/.exec(range)
      const middle = /^(\d{1,3})-(\d{1,3})$/.exec(range)

      if (suffix) {
        const percent = Math.min(Number(suffix[2]), 100)
        const count = Math.max(1, Math.floor(all.length * percent / 100))
        body = suffix[1] === '+' ? all.slice(0, count).join('') : all.slice(-count).join('')
        note = `（${suffix[1] === '+' ? '前' : '后'} ${percent}%，共 ${all.length} 字）`
      } else if (middle) {
        const from = Number(middle[1])
        const to = Number(middle[2])
        if (from >= to || to > 100) throw new Error('中间区间要写成 35-55 这样，且开始小于结束、最大 100')

        const start = Math.min(all.length, Math.floor(all.length * from / 100))
        let end = Math.min(all.length, Math.floor(all.length * to / 100))
        if (all.length > 0 && end <= start) end = Math.min(all.length, start + 1)
        body = all.slice(start, end).join('')
        note = `（${from}%–${to}%，第 ${start + 1}–${end} 字，共 ${all.length} 字）`
      } else {
        throw new Error('范围要写成 +20、-30 或 35-55 这样')
      }
    }

    const bodyLength = [...body].length
    if (bodyLength > MAX_CHARS) {
      const kept = [...body].slice(0, MAX_CHARS).join('')
      return `档案 ${date}#${id}${note}\n\n${kept}\n\n（这段还有 ${bodyLength - MAX_CHARS} 字，用 range 再分段看）`
    }

    return `档案 ${date}#${id}${note}\n范围：${segment.range}\n摘要：${segment.summary}\n\n${body}`
  },
})
