import { getToolParameterKeys } from '../registries/tools.ts'

/**
 * 把一个工具调用排版成会话历史里的可读形式。
 *
 *   memo        + {text:"提醒吃药"}   → memo("提醒吃药")
 *   alarm_set   + {at:"00:12", …}     → alarm_set("00:12", "看看脚本")
 *   sleep       + {}                  → sleep()
 *
 * 规则：
 * - 参数顺序按工具 schema 里声明的顺序；schema 里没声明的，按模型实际给的顺序补在后面
 * - 字符串加双引号（JSON 风格），数字/布尔/null 原样
 * - 对象/数组转成 JSON
 */
export function formatToolCall(name: string, args: unknown): string {
  // 参数不是对象时，原样显示，免得历史里变成 "memo()" 看不出模型给了什么
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return args === undefined ? `${name}()` : `${name}(${renderValue(args)})`
  }

  const record = args as Record<string, unknown>

  const declared = getToolParameterKeys(name)
  const keys = [
    ...declared.filter(key => key in record),
    ...Object.keys(record).filter(key => !declared.includes(key)),
  ]

  const parts = keys.map(key => renderValue(record[key]))
  return `${name}(${parts.join(', ')})`
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
