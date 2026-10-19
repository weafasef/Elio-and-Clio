import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTool } from '../registries/tools.ts'

/** 备忘录限长（方案里定的 200 字） */
const MAX_CHARS = 200

registerTool({
  name: 'memo',
  description: '写或清空我的备忘录。传内容则整段覆盖；传空字符串则清空。',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要写入备忘录的整段内容；传空字符串表示清空',
      },
    },
    required: ['text'],
  },
  run(args, ctx) {
    // 到这里的 args 已经过 schema 校验：text 一定存在，且一定是字符串
    const text = args.text as string
    const file = join(ctx.dataDir, 'memo.txt')

    // 只有恰好传了空字符串才算清空
    if (text === '') {
      writeFileSync(file, '')
      return '备忘录已清空'
    }

    // 其余情况一律整段覆写
    const length = [...text].length
    if (length > MAX_CHARS) {
      return `错误：备忘录最多 ${MAX_CHARS} 字，你现在写了 ${length} 字，没有保存`
    }

    writeFileSync(file, text)
    return '备忘录已更新'
  },
})
