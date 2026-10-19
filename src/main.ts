import { loadConfig } from './config.ts'
import './tools/memo.ts'
import './tools/sleep.ts'
import { startServer } from './web/server.ts'

const config = loadConfig()

// 起网页服务（监听 127.0.0.1:config.port）
const server = startServer(config)

console.log('eh 启动')
console.log(`  数据目录：${config.dataDir}`)
console.log(`  模型：    ${config.model}`)
console.log(`  网页：    http://127.0.0.1:${config.port}`)
console.log('  （Ctrl+C 退出）')

const shutdown = async (signal: string) => {
  console.log(`\n收到 ${signal}，正在关闭…`)
  await server.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
