import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 桌宠身体状态与控制通道。
 *
 * 状态保存在 dataDir/body.json，供感知缓存 {{body}} 和 body 工具读取。
 * 控制指令通过 subscribeBodyControl 推给 server.ts 的 SSE，再由舞台转发给 Electron。
 */

export type BodyPreset =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'center'
  | 'peek-right'
  | 'peek-left'

export type BodyState = {
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  scale: number
  screenWidth: number
  screenHeight: number
  showText: boolean
  showComposer: boolean
  clickThrough: boolean
  updatedAt: number
}

export type BodyCommand = {
  requestId?: number
  visible?: boolean
  preset?: BodyPreset
  x?: number
  y?: number
  dx?: number
  dy?: number
  scale?: number
  showText?: boolean
  showComposer?: boolean
}

const DEFAULT_STATE: BodyState = {
  visible: true,
  x: 996,
  y: 285,
  width: 420,
  height: 504,
  scale: 70,
  screenWidth: 1440,
  screenHeight: 900,
  showText: true,
  showComposer: true,
  clickThrough: true,
  updatedAt: 0,
}

let nextRequestId = 1
const controlListeners = new Set<(command: BodyCommand) => void>()
const stateWaiters = new Map<number, (state: BodyState) => void>()

function bodyFile(dataDir: string): string {
  return join(dataDir, 'body.json')
}

export function readBodyState(dataDir: string): BodyState {
  try {
    const raw = JSON.parse(readFileSync(bodyFile(dataDir), 'utf8')) as Partial<BodyState>
    if (raw && typeof raw === 'object') {
      return {
        visible: typeof raw.visible === 'boolean' ? raw.visible : DEFAULT_STATE.visible,
        x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? Math.round(raw.x) : DEFAULT_STATE.x,
        y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? Math.round(raw.y) : DEFAULT_STATE.y,
        width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? Math.round(raw.width) : DEFAULT_STATE.width,
        height: typeof raw.height === 'number' && Number.isFinite(raw.height) ? Math.round(raw.height) : DEFAULT_STATE.height,
        scale: typeof raw.scale === 'number' && Number.isFinite(raw.scale) ? Math.round(raw.scale) : DEFAULT_STATE.scale,
        screenWidth: typeof raw.screenWidth === 'number' && Number.isFinite(raw.screenWidth) ? Math.round(raw.screenWidth) : DEFAULT_STATE.screenWidth,
        screenHeight: typeof raw.screenHeight === 'number' && Number.isFinite(raw.screenHeight) ? Math.round(raw.screenHeight) : DEFAULT_STATE.screenHeight,
        showText: typeof raw.showText === 'boolean' ? raw.showText : DEFAULT_STATE.showText,
        showComposer: typeof raw.showComposer === 'boolean' ? raw.showComposer : DEFAULT_STATE.showComposer,
        clickThrough: typeof raw.clickThrough === 'boolean' ? raw.clickThrough : DEFAULT_STATE.clickThrough,
        updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      }
    }
  } catch {
    // 还没有或坏了，返回默认
  }
  return { ...DEFAULT_STATE }
}

export function writeBodyState(
  dataDir: string,
  patch: Partial<BodyState>,
  requestId?: number,
): BodyState {
  const current = readBodyState(dataDir)
  const next: BodyState = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }

  mkdirSync(dataDir, { recursive: true })
  const target = bodyFile(dataDir)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)

  if (requestId !== undefined) {
    const waiter = stateWaiters.get(requestId)
    if (waiter) {
      stateWaiters.delete(requestId)
      waiter(next)
    }
  }

  return next
}

export function subscribeBodyControl(listener: (command: BodyCommand) => void): () => void {
  controlListeners.add(listener)
  return () => controlListeners.delete(listener)
}

/**
 * 发送身体控制指令，并等待 Electron 回报最新状态（超时则用本地推算值兜底）。
 */
export async function dispatchBodyControl(
  dataDir: string,
  command: BodyCommand,
  timeoutMs = 500,
): Promise<BodyState> {
  const requestId = nextRequestId++
  const payload: BodyCommand = { ...command, requestId }

  if (controlListeners.size === 0) {
    return applyFallbackCommand(dataDir, command)
  }

  const waitPromise = new Promise<BodyState>(resolve => {
    const timer = setTimeout(() => {
      stateWaiters.delete(requestId)
      resolve(applyFallbackCommand(dataDir, command))
    }, timeoutMs)

    stateWaiters.set(requestId, state => {
      clearTimeout(timer)
      resolve(state)
    })
  })

  for (const listener of [...controlListeners]) {
    try {
      listener(payload)
    } catch {
      // 忽略单个监听异常
    }
  }

  return waitPromise
}

function applyFallbackCommand(dataDir: string, command: BodyCommand): BodyState {
  const current = readBodyState(dataDir)
  const scale = command.scale !== undefined
    ? Math.max(70, Math.min(115, Math.round(command.scale)))
    : current.scale
  const width = 420
  const height = Math.max(420, Math.round(720 * (scale / 100)))
  const screenWidth = current.screenWidth || 1440
  const screenHeight = current.screenHeight || 900

  let x = current.x
  let y = current.y

  if (command.preset) {
    const pos = computePresetPosition(command.preset, {
      x,
      y,
      width,
      height,
      workX: 0,
      workY: 0,
      workWidth: screenWidth,
      workHeight: screenHeight,
    })
    x = pos.x
    y = pos.y
  }
  if (command.x !== undefined) x = Math.round(command.x)
  if (command.y !== undefined) y = Math.round(command.y)
  if (command.dx !== undefined) x += Math.round(command.dx)
  if (command.dy !== undefined) y += Math.round(command.dy)

  const clamped = clampPartiallyVisible(x, y, width, height, 0, 0, screenWidth, screenHeight)

  return writeBodyState(dataDir, {
    visible: command.visible !== undefined ? command.visible : current.visible,
    x: clamped.x,
    y: clamped.y,
    width,
    height,
    scale,
    showText: command.showText !== undefined ? command.showText : current.showText,
    showComposer: command.showComposer !== undefined ? command.showComposer : current.showComposer,
  })
}

export function computePresetPosition(
  preset: BodyPreset,
  box: {
    x: number
    y: number
    width: number
    height: number
    workX: number
    workY: number
    workWidth: number
    workHeight: number
  },
): { x: number, y: number } {
  const margin = 24
  const { width, height, workX, workY, workWidth, workHeight } = box
  switch (preset) {
    case 'bottom-right':
      return {
        x: workX + workWidth - width - margin,
        y: workY + workHeight - height - margin,
      }
    case 'bottom-left':
      return {
        x: workX + margin,
        y: workY + workHeight - height - margin,
      }
    case 'top-right':
      return {
        x: workX + workWidth - width - margin,
        y: workY + margin,
      }
    case 'top-left':
      return {
        x: workX + margin,
        y: workY + margin,
      }
    case 'center':
      return {
        x: workX + Math.round((workWidth - width) / 2),
        y: workY + Math.round((workHeight - height) / 2),
      }
    case 'peek-right':
      return {
        x: workX + workWidth - Math.round(width * 0.45),
        y: box.y,
      }
    case 'peek-left':
      return {
        x: workX - Math.round(width * 0.55),
        y: box.y,
      }
  }
}

export function clampPartiallyVisible(
  x: number,
  y: number,
  width: number,
  height: number,
  workX: number,
  workY: number,
  workWidth: number,
  workHeight: number,
): { x: number, y: number } {
  const minVisible = 80
  const minX = workX - width + minVisible
  const maxX = workX + workWidth - minVisible
  const minY = workY - height + minVisible
  const maxY = workY + workHeight - minVisible
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  }
}

export function renderBodyState(dataDir: string): string {
  const state = readBodyState(dataDir)
  const visibility = state.visible ? '显示中' : '已隐藏'
  const area = describeScreenRegion(state)
  const ui = `台词框${state.showText ? '开' : '关'}，输入框${state.showComposer ? '开' : '关'}`
  return `${visibility}，${area} (${state.x}, ${state.y} / 屏幕 ${state.screenWidth}×${state.screenHeight})，尺寸 ${state.scale}%（窗口 ${state.width}×${state.height}，${ui}）`
}

function describeScreenRegion(state: BodyState): string {
  const cx = state.x + state.width / 2
  const cy = state.y + state.height / 2
  const w = state.screenWidth || 1440
  const h = state.screenHeight || 900

  if (state.x + state.width > w + 40) return '右缘探头'
  if (state.x < -40) return '左缘探头'

  const hPart = cx < w * 0.35 ? '左' : cx > w * 0.65 ? '右' : '中'
  const vPart = cy < h * 0.35 ? '上' : cy > h * 0.65 ? '下' : '中'
  if (hPart === '中' && vPart === '中') return '正中'
  return `${hPart}${vPart}`
}
