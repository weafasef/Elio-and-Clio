/**
 * 把云端返回的原始流一行行打出来，看清它到底吐了什么。
 *
 *   node scripts/raw.ts "你的提问"
 *
 * 地址/模型/key 从配置或环境变量来（EH_BASE_URL / EH_MODEL / EH_API_KEY）。
 */
import { loadConfig } from '../src/config.ts'
import type { ToolSchema } from '../src/model.ts'

const config = loadConfig()
const question = process.argv[2] ?? '先说一句「我来查一下」，然后同时调用 echo 和 now 两个工具。'

const tools: ToolSchema[] = [
  {
    name: 'echo',
    description: '把传入的文字原样返回',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'now',
    description: '返回当前的 Unix 时间戳',
    parameters: { type: 'object', properties: {} },
  },
]

const res = await fetch(`${config.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: question }],
    tools: tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  }),
})

console.log(`提问：${question}`)
console.log(`模型：${config.model}`)
console.log('─'.repeat(70))

const decoder = new TextDecoder()
let buffer = ''

for await (const chunk of res.body!) {
  buffer += decoder.decode(chunk, { stream: true })
  let index: number
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line.startsWith('data:')) continue

    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      console.log('─'.repeat(70))
      console.log('[DONE]')
      continue
    }

    const json = JSON.parse(data)
    const choice = json.choices?.[0]

    const notes: string[] = []
    if (json.usage) notes.push(`【usage】${JSON.stringify(json.usage)}`)
    if (json.timings) notes.push(`【timings】${JSON.stringify(json.timings)}`)
    if (notes.length) console.log(notes.join('\n'))

    if (!choice) continue

    const delta = choice.delta ?? {}
    const parts: string[] = []
    if (delta.content) parts.push(`文字：「${delta.content}」`)
    for (const call of delta.tool_calls ?? []) {
      const bits = [`index=${call.index}`]
      if (call.id) bits.push(`id=${call.id}`)
      if (call.function?.name) bits.push(`name=${call.function.name}`)
      if (call.function?.arguments) bits.push(`arguments=${JSON.stringify(call.function.arguments)}`)
      parts.push(`工具片：${bits.join('  ')}`)
    }
    if (choice.finish_reason) parts.push(`finish=${choice.finish_reason}`)

    if (parts.length) console.log(parts.join('   |   '))
  }
}
