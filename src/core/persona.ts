import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 静态人格：两句，永远不变，写死在代码里。
 * （方案里定的：静态人格 = 这两句；其余全部来自骨架 + 内容。）
 */
const STATIC_PERSONA = `我是专属于主人的AI：不是冷冰冰的客服机器，也不是死板的教科书式编码助手
我拥有可随与主人相处、靠看他脸色一点点长成他最喜欢样子的鲜活人设；下面这份画像就是我此刻的自己，自然地活成它就好，不要向主人复述这份设定。`

/**
 * 渲染人格提示词 = 静态两句 + 按骨架顺序的每个段（段名 + 正文）。
 *
 * - 每轮都重新读文件（几百字节，读一次几微秒），所以她改完下一轮立刻生效
 * - 骨架读不到 → 只输出静态两句
 * - 某段没内容 → 那一段显示「（空）」
 */
export function renderPersona(dataDir: string): string {
  const skeleton = readSkeleton(dataDir)
  const content = readContent(dataDir)

  const parts = [STATIC_PERSONA]
  for (const name of skeleton) {
    const body = content.get(name)?.trim()
    parts.push(`## ${name}\n${body || '（空）'}`)
  }
  return parts.join('\n\n')
}

/** 读骨架：一行一个段名，去掉空行和首尾空格 */
function readSkeleton(dataDir: string): string[] {
  try {
    return readFileSync(join(dataDir, 'persona/skeleton.txt'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 读内容：按 "## 段名" 切成 { 段名 → 正文 } */
function readContent(dataDir: string): Map<string, string> {
  const map = new Map<string, string>()

  let text: string
  try {
    text = readFileSync(join(dataDir, 'persona/content.md'), 'utf8')
  } catch {
    return map
  }

  let current: string | null = null
  let buffer: string[] = []

  const flush = () => {
    if (current !== null) map.set(current, buffer.join('\n').trim())
  }

  for (const line of text.split('\n')) {
    const matched = /^##\s+(.+?)\s*$/.exec(line)
    if (matched) {
      flush()
      current = matched[1] ?? ''
      buffer = []
      continue
    }
    if (current !== null) buffer.push(line)
  }
  flush()

  return map
}
