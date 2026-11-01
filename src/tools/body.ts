import { registerTool } from '../registries/tools.ts'
import {
  dispatchBodyControl,
  renderBodyState,
  type BodyCommand,
  type BodyPreset,
} from '../core/body.ts'

const PRESETS = new Set<BodyPreset>([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
  'peek-right',
  'peek-left',
])

registerTool({
  name: 'body',
  description:
    '控制我自己的桌宠身体（位置、大小、显示/隐藏、台词框和输入框开关）。' +
    '位置移动带有 0.3 秒平滑滑动过渡，支持部分移出屏幕边缘（如探头）。' +
    '不传任何参数时只查看当前身体状态。',
  parameters: {
    type: 'object',
    properties: {
      visible: {
        type: 'boolean',
        description: 'true 显示桌宠，false 隐藏桌宠',
      },
      preset: {
        type: 'string',
        enum: [
          'bottom-right',
          'bottom-left',
          'top-right',
          'top-left',
          'center',
          'peek-right',
          'peek-left',
        ],
        description:
          '快捷位置：bottom-right（右下）、bottom-left（左下）、top-right（右上）、top-left（左上）、' +
          'center（正中）、peek-right（右边缘探出半身）、peek-left（左边缘探出半身）',
      },
      x: {
        type: 'integer',
        description: '目标左上角横坐标（可部分超出屏幕边界）',
      },
      y: {
        type: 'integer',
        description: '目标左上角纵坐标（可部分超出屏幕边界）',
      },
      dx: {
        type: 'integer',
        description: '相对当前横坐标偏移像素（正数往右，负数往左）',
      },
      dy: {
        type: 'integer',
        description: '相对当前纵坐标偏移像素（正数往下，负数往上）',
      },
      scale: {
        type: 'integer',
        description: '身体大小百分比，70 ~ 115',
      },
      showText: {
        type: 'boolean',
        description: '是否显示台词框和控制条',
      },
      showComposer: {
        type: 'boolean',
        description: '是否显示底部打字输入框',
      },
    },
  },
  async run(args, ctx) {
    const command: BodyCommand = {}
    let hasChange = false

    if (args.visible !== undefined) {
      command.visible = Boolean(args.visible)
      hasChange = true
    }

    if (args.preset !== undefined) {
      const preset = String(args.preset) as BodyPreset
      if (!PRESETS.has(preset)) {
        throw new Error(`preset 只能是：${[...PRESETS].join(' / ')}`)
      }
      command.preset = preset
      hasChange = true
    }

    if (args.x !== undefined) {
      const x = Number(args.x)
      if (!Number.isInteger(x)) throw new Error('x 必须是整数')
      command.x = x
      hasChange = true
    }

    if (args.y !== undefined) {
      const y = Number(args.y)
      if (!Number.isInteger(y)) throw new Error('y 必须是整数')
      command.y = y
      hasChange = true
    }

    if (args.dx !== undefined) {
      const dx = Number(args.dx)
      if (!Number.isInteger(dx)) throw new Error('dx 必须是整数')
      command.dx = dx
      hasChange = true
    }

    if (args.dy !== undefined) {
      const dy = Number(args.dy)
      if (!Number.isInteger(dy)) throw new Error('dy 必须是整数')
      command.dy = dy
      hasChange = true
    }

    if (args.scale !== undefined) {
      const scale = Number(args.scale)
      if (!Number.isInteger(scale) || scale < 70 || scale > 115) {
        throw new Error('scale 必须是 70 ~ 115 之间的整数')
      }
      command.scale = scale
      hasChange = true
    }

    if (args.showText !== undefined) {
      command.showText = Boolean(args.showText)
      hasChange = true
    }

    if (args.showComposer !== undefined) {
      command.showComposer = Boolean(args.showComposer)
      hasChange = true
    }

    if (!hasChange) {
      return `当前身体状态：${renderBodyState(ctx.dataDir)}`
    }

    await dispatchBodyControl(ctx.dataDir, command)
    return `身体已更新：${renderBodyState(ctx.dataDir)}`
  },
})
