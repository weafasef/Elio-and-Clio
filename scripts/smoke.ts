/**
 * M1 冒烟测试：在一个临时实例目录里跑完整的一步（组装 → 调模型 → 工具 → sleep）。
 *
 *   node scripts/smoke.ts
 *
 * 配置走 ~/.eh/config.json 或环境变量（EH_BASE_URL / EH_MODEL / EH_API_KEY）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { appendHistory, readHistory } from '../src/core/history.ts'
import { runStep } from '../src/core/loop.ts'
import '../src/tools/memo.ts'
import '../src/tools/sleep.ts'

const base = loadConfig()
const dataDir = mkdtempSync(join(tmpdir(), 'eh-smoke-'))
mkdirSync(join(dataDir, 'persona'), { recursive: true })

writeFileSync(
  join(dataDir, 'persona', 'skeleton.txt'),
  '工具使用事项\n',
)
writeFileSync(
  join(dataDir, 'persona', 'content.md'),
  [
    '## 工具使用事项',
    '- memo：写或清空我的备忘录。',
    '- sleep：我没事可做了，就调用它结束，不然会一直转下去。',
    '',
  ].join('\n'),
)

appendHistory(dataDir, '外界消息', '主人：跟我说一句话，然后调用 sleep 结束。')

console.log('实例目录:', dataDir)
console.log('模型:', base.model)
console.log('─'.repeat(60))

let loops = 0
let tools: string[] = []

await runStep({ ...base, dataDir }, {
  wakeSource: '外界消息',
  onText: piece => process.stdout.write(piece),
  onLoopStart: n => { loops = n },
  onToolCall: name => tools.push(name),
  onDone: () => console.log('\n' + '─'.repeat(60) + '\n本步结束'),
})

console.log('轮数:', loops, '| 调用的工具:', tools.join(', ') || '（无）')
console.log('\n会话历史：')
for (const entry of readHistory(dataDir)) {
  console.log(`  ${entry.t}  ${entry.src}  ${entry.text}`)
}
