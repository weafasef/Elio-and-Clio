import { registerTool } from '../registries/tools.ts'

registerTool({
  name: 'sleep',
  description: '我这一轮没事可做了，就调用它结束。没有参数。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run() {
    return '已休眠'
  },
})
