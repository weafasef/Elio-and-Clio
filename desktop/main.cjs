'use strict'

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell, session, globalShortcut, powerMonitor, systemPreferences } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let globalKeyHook = null
let globalKeyCodes = null
try {
  const hook = require('uiohook-napi')
  globalKeyHook = hook.uIOhook
  globalKeyCodes = hook.UiohookKey
} catch (error) {
  console.error('[pet] uiohook-napi 加载失败：', error.message)
}

const STAGE_URL = process.env.EH_STAGE_URL || 'http://127.0.0.1:8099/stage?pet=1'
const STAGE_ORIGIN = new URL(STAGE_URL).origin
const BASE_WIDTH = 420
const BASE_HEIGHT = 720
const MIN_SCALE = 0.7
const MAX_SCALE = 1.15
const OFFLINE_FILE = path.join(__dirname, 'offline.html')
const OFFLINE_URL = pathToFileURL(OFFLINE_FILE).href
const SHORTCUTS_FILE = path.join(__dirname, 'shortcuts.html')
const TRAY_ICON = path.join(__dirname, 'trayTemplate.png')

const SHORTCUT_LABELS = {
  toggleClickThrough: '点击穿透',
  toggleWindow: '显示/隐藏 Elio',
  toggleTextControls: '显示文字和进度条',
  toggleComposer: '显示输入框',
}

const DEFAULT_SHORTCUTS = {
  toggleClickThrough: 'CommandOrControl+Shift+E',
  toggleWindow: 'CommandOrControl+Shift+H',
  toggleTextControls: 'CommandOrControl+Shift+U',
  toggleComposer: 'CommandOrControl+Shift+I',
}

let win = null
let settingsWin = null
let tray = null
let isQuitting = false
let windowHiddenByUser = false
let rendererIgnoreMouse = false
let screenshotDone = false
let dragState = null
let dragTimer = null
let dragSafety = null
let smoothMoveTimer = null
let currentScalePercent = 70
let registeredShortcuts = {}
let shortcutErrors = []
let presenceWatchTimer = null
let lastIdleSeconds = 0
let lastPresenceCheckAt = 0
let pendingWindowBounds = null
let presenceResetInFlight = false
let lastWindowResetAt = 0
let globalVoiceEnabled = false
let globalVoicePermissionNeeded = false
let globalVoiceError = ''
let globalVoiceHookAttached = false
let voiceControlDown = false
let voiceMetaDown = false
let voiceArming = false
let voiceActive = false
let voiceArmTimer = null
let trayVoiceState = 'idle'
const IDLE_RETURN_THRESHOLD_S = 60
const IDLE_ACTIVE_THRESHOLD_S = 10
const IDLE_POLL_MS = 5_000
const IDLE_TIMER_GAP_MS = 15_000
const ALARM_SAFE_MS = 3 * 60_000
const WINDOW_RESET_COOLDOWN_MS = 60_000
let settings = {
  showTextAndControls: true,
  showComposer: true,
  clickThrough: true,
  shortcuts: { ...DEFAULT_SHORTCUTS },
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  app.whenReady().then(() => {
    app.setName('Elio')
    loadSettings()

    if (process.platform === 'darwin' && !process.env.EH_PET_KEEP_DOCK) {
      app.dock.hide()
    }

    // 只允许舞台页使用麦克风；其他权限继续全部拒绝。
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      if (permission !== 'media') return false
      let origin = ''
      try {
        origin = new URL(requestingOrigin).origin
      } catch {
        return false
      }
      if (origin !== STAGE_ORIGIN) return false
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
      return details?.mediaType !== 'video' && !mediaTypes.includes('video')
    })

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission !== 'media') {
        callback(false)
        return
      }

      let origin = ''
      try {
        origin = new URL(details?.requestingUrl || webContents.getURL()).origin
      } catch {
        callback(false)
        return
      }

      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
      callback(origin === STAGE_ORIGIN && !mediaTypes.includes('video'))
    })

    applyShortcuts()
    createTray()
    createWindow()
    startGlobalVoiceHotkey(false)

    if (process.platform === 'darwin') {
      const restoreAfterWake = () => {
        restoreWindowPresence()
        void restartPetWindowIfIdle()
        setTimeout(() => {
          restoreWindowPresence()
          void restartPetWindowIfIdle()
        }, 1_000)
        setTimeout(() => {
          restoreWindowPresence()
          void restartPetWindowIfIdle()
        }, 3_000)
      }
      powerMonitor.on('resume', restoreAfterWake)
      powerMonitor.on('unlock-screen', restoreAfterWake)
      startPresenceWatch()
    }

    app.on('activate', () => {
      if (win) showWindow()
      else createWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 桌宠没有 Dock 图标，关窗后留在托盘，不退出。
})

app.on('will-quit', () => {
  if (presenceWatchTimer) {
    clearInterval(presenceWatchTimer)
    presenceWatchTimer = null
  }
  stopGlobalVoiceHotkey()
  globalShortcut.unregisterAll()
  if (tray) {
    tray.destroy()
    tray = null
  }
})

function createWindow() {
  if (win) {
    showWindow()
    return
  }

  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.max(workArea.x, workArea.x + workArea.width - BASE_WIDTH - 24)
  const y = Math.max(workArea.y, workArea.y + workArea.height - BASE_HEIGHT - 24)

  win = new BrowserWindow({
    x,
    y,
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    type: 'panel',
    focusable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    show: false,
    title: 'Elio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  const thisWindow = win

  win.setAlwaysOnTop(true, 'floating')

  win.once('ready-to-show', () => {
    if (!win) return
    if (pendingWindowBounds) {
      win.setBounds(pendingWindowBounds, false)
      pendingWindowBounds = null
    }
    win.showInactive()
    if (process.env.EH_PET_DEBUG) {
      console.log('[pet] window:', win.getBounds())
      console.log('[pet] window type:', 'panel')
      console.log('[pet] always on top:', win.isAlwaysOnTop())
      console.log('[pet] dock visible:', process.platform === 'darwin' ? app.dock.isVisible() : 'n/a')
    }
    reportBodyState()
    captureForDebug()
  })

  win.on('show', () => {
    rebuildTrayMenu()
    reportBodyState()
  })
  win.on('hide', () => {
    endWindowDrag()
    rebuildTrayMenu()
    reportBodyState()
  })

  win.on('blur', endWindowDrag)

  win.on('close', event => {
    if (!isQuitting) {
      event.preventDefault()
      windowHiddenByUser = true
      win.hide()
    }
  })

  win.on('closed', () => {
    endWindowDrag()
    // 重建窗口时，旧窗口的 closed 可能晚于新窗口创建，不能把新窗口清掉。
    if (win === thisWindow) win = null
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(STAGE_ORIGIN + '/')) return
    if (url.startsWith(OFFLINE_URL)) return
    event.preventDefault()
  })

  win.webContents.on('will-attach-webview', event => {
    event.preventDefault()
  })

  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (validatedURL.startsWith(STAGE_ORIGIN + '/')) loadOffline()
  })

  win.webContents.on('did-finish-load', () => {
    sendUiState()
    sendVoiceHotkeyMode()
    setTrayVoiceState('idle')
  })

  loadStage()
}

/**
 * 显示器单独睡眠时，macOS 不一定发 resume / unlock-screen。
 * 用系统空闲时间从长时间闲置突然归零，判断“主人刚回来”，再补一次跨桌面状态。
 */
function startPresenceWatch() {
  if (presenceWatchTimer) return
  try {
    lastIdleSeconds = powerMonitor.getSystemIdleTime()
  } catch {
    lastIdleSeconds = 0
  }
  lastPresenceCheckAt = Date.now()
  if (process.env.EH_PET_DEBUG) console.log('[pet] presence watch started')

  presenceWatchTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return

    let idleSeconds
    try {
      idleSeconds = powerMonitor.getSystemIdleTime()
    } catch {
      return
    }

    const now = Date.now()
    const timerGap = now - lastPresenceCheckAt
    lastPresenceCheckAt = now

    const returnedFromIdle =
      lastIdleSeconds >= IDLE_RETURN_THRESHOLD_S &&
      idleSeconds <= IDLE_ACTIVE_THRESHOLD_S
    // 显示器睡眠时主进程的定时器可能被压制，醒来后第一次检查的间隔会明显变大。
    const timerWasSuspended =
      timerGap >= IDLE_TIMER_GAP_MS &&
      idleSeconds <= IDLE_ACTIVE_THRESHOLD_S
    // 空闲达到阈值时也试一次，覆盖“显示器睡了但系统没休眠”的情况。
    const justWentIdle =
      lastIdleSeconds < IDLE_RETURN_THRESHOLD_S &&
      idleSeconds >= IDLE_RETURN_THRESHOLD_S

    if (returnedFromIdle || timerWasSuspended || justWentIdle) {
      if (process.env.EH_PET_DEBUG) {
        console.log('[pet] idle return:', { lastIdleSeconds, idleSeconds, timerGap })
      }
      // 先让它恢复一次；如果 Elio 空闲，再重建桌宠窗口，彻底重置窗口的桌面状态。
      restoreWindowPresence()
      // 进入空闲/从睡眠恢复时重建；单纯“回到电脑前”只恢复，避免一次空闲重启两次。
      if (justWentIdle || timerWasSuspended) void restartPetWindowIfIdle()
    }

    lastIdleSeconds = idleSeconds
  }, IDLE_POLL_MS)
}

/**
 * 只重建桌宠窗口，不重启后端。
 * 先问 /status，确认她没在思考/说话，避免打断正在进行的对话。
 */
function restartPetWindowIfIdle() {
  if (presenceResetInFlight) return
  if (!win || win.isDestroyed() || windowHiddenByUser) return
  if (Date.now() - lastWindowResetAt < WINDOW_RESET_COOLDOWN_MS) return

  presenceResetInFlight = true
  void (async () => {
    try {
      const response = await fetch(`${STAGE_ORIGIN}/status`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) return
      const status = await response.json()
      const alarmSafe =
        status.nextAlarmInMs === null ||
        status.nextAlarmInMs > ALARM_SAFE_MS

      if (!status.sleeping || !alarmSafe) {
        if (process.env.EH_PET_DEBUG) {
          console.log('[pet] idle return: skip window reset', {
            sleeping: status.sleeping,
            nextAlarmInMs: status.nextAlarmInMs,
          })
        }
        return
      }

      if (process.env.EH_PET_DEBUG) console.log('[pet] idle return: recreating pet window')
      if (recreatePetWindow()) lastWindowResetAt = Date.now()
    } catch (error) {
      if (process.env.EH_PET_DEBUG) {
        console.log('[pet] idle return: status check failed:', error.message)
      }
    } finally {
      presenceResetInFlight = false
    }
  })()
}

function recreatePetWindow() {
  if (!win || win.isDestroyed() || windowHiddenByUser) return false

  pendingWindowBounds = win.getBounds()
  const oldWindow = win
  win = null
  oldWindow.destroy()
  createWindow()
  return true
}

function restoreWindowPresence() {
  if (!win || win.isDestroyed()) return

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })

  if (win.isMinimized()) win.restore()
  if (!win.isVisible() && !windowHiddenByUser) win.showInactive()
  else if (win.isVisible()) win.moveTop()

  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] restore window presence:', {
      visible: win.isVisible(),
      hiddenByUser: windowHiddenByUser,
      bounds: win.getBounds(),
    })
  }
}

function showWindow() {
  if (!win) {
    createWindow()
    return
  }
  windowHiddenByUser = false
  win.show()
  win.focus()
  restoreWindowPresence()
}

function toggleWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isVisible()) {
    windowHiddenByUser = true
    win.hide()
  } else {
    windowHiddenByUser = false
    restoreWindowPresence()
  }
}

function loadStage() {
  if (!win) return
  resetRendererIgnore()
  win.loadURL(STAGE_URL).catch(error => {
    if (process.env.EH_PET_DEBUG) console.error('[pet] stage load failed:', error.message)
  })
}

function loadOffline() {
  if (!win) return
  resetRendererIgnore()
  win.loadFile(OFFLINE_FILE).catch(error => {
    if (process.env.EH_PET_DEBUG) console.error('[pet] offline load failed:', error.message)
  })
}

function resetRendererIgnore() {
  rendererIgnoreMouse = false
  applyMouseIgnore()
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'pet-settings.json')
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    const rawShortcuts = raw.shortcuts && typeof raw.shortcuts === 'object' ? raw.shortcuts : {}
    const shortcuts = {}
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      shortcuts[key] = typeof rawShortcuts[key] === 'string'
        ? rawShortcuts[key]
        : DEFAULT_SHORTCUTS[key]
    }
    settings = {
      showTextAndControls: raw.showTextAndControls !== false,
      showComposer: raw.showComposer !== false,
      clickThrough: raw.clickThrough !== false,
      shortcuts,
    }
  } catch {
    // 没有配置就用默认值
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  } catch {
    // 存不了也不影响这次使用
  }
}

function sendUiState(includeScale = false) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:ui-state', {
    showTextAndControls: settings.showTextAndControls,
    showComposer: settings.showComposer,
    clickThrough: settings.clickThrough,
    ...(includeScale ? { scale: currentScalePercent } : {}),
  })
}

function applyMouseIgnore() {
  if (!win) return
  const ignore = settings.clickThrough ? rendererIgnoreMouse : false
  win.setIgnoreMouseEvents(ignore, { forward: true })
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] ignore mouse:', ignore, 'clickThrough:', settings.clickThrough)
  }
}

function cancelSmoothMove() {
  if (smoothMoveTimer) {
    clearInterval(smoothMoveTimer)
    smoothMoveTimer = null
  }
}

function animateWindowPosition(targetX, targetY, durationMs = 300) {
  if (!win || win.isDestroyed()) return
  cancelSmoothMove()

  const [startX, startY] = win.getPosition()
  const dx = Math.round(targetX) - startX
  const dy = Math.round(targetY) - startY
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
    win.setPosition(Math.round(targetX), Math.round(targetY), false)
    return
  }

  const startedAt = Date.now()
  smoothMoveTimer = setInterval(() => {
    if (!win || win.isDestroyed() || dragState) {
      cancelSmoothMove()
      return
    }
    const elapsed = Date.now() - startedAt
    const t = Math.min(1, elapsed / Math.max(1, durationMs))
    const eased = 1 - Math.pow(1 - t, 3)
    const nextX = Math.round(startX + dx * eased)
    const nextY = Math.round(startY + dy * eased)
    win.setPosition(nextX, nextY, false)
    if (t >= 1) {
      cancelSmoothMove()
      reportBodyState()
    }
  }, 16)
}

function clampPartiallyVisible(x, y, width, height, workArea) {
  const minVisible = 80
  const minX = workArea.x - width + minVisible
  const maxX = workArea.x + workArea.width - minVisible
  const minY = workArea.y - height + minVisible
  const maxY = workArea.y + workArea.height - minVisible
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  }
}

function computePresetPosition(preset, bounds, workArea) {
  const margin = 24
  const { width, height } = bounds
  switch (preset) {
    case 'bottom-right':
      return {
        x: workArea.x + workArea.width - width - margin,
        y: workArea.y + workArea.height - height - margin,
      }
    case 'bottom-left':
      return {
        x: workArea.x + margin,
        y: workArea.y + workArea.height - height - margin,
      }
    case 'top-right':
      return {
        x: workArea.x + workArea.width - width - margin,
        y: workArea.y + margin,
      }
    case 'top-left':
      return {
        x: workArea.x + margin,
        y: workArea.y + margin,
      }
    case 'center':
      return {
        x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
      }
    case 'peek-right':
      return {
        x: workArea.x + workArea.width - Math.round(width * 0.45),
        y: bounds.y,
      }
    case 'peek-left':
      return {
        x: workArea.x - Math.round(width * 0.55),
        y: bounds.y,
      }
    default:
      return { x: bounds.x, y: bounds.y }
  }
}

function reportBodyState(requestId, overrideBounds) {
  if (!win || win.isDestroyed()) return
  const bounds = overrideBounds ? { ...win.getBounds(), ...overrideBounds } : win.getBounds()
  const { workArea } = screen.getPrimaryDisplay()
  const payload = {
    ...(typeof requestId === 'number' ? { requestId } : {}),
    visible: Boolean(win.isVisible() && !windowHiddenByUser),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    scale: Math.round(currentScalePercent),
    screenWidth: Math.round(workArea.width),
    screenHeight: Math.round(workArea.height),
    showText: settings.showTextAndControls !== false,
    showComposer: settings.showComposer !== false,
    clickThrough: settings.clickThrough !== false,
  }
  void fetch(`${STAGE_ORIGIN}/body/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1_500),
  }).catch(() => {
    // 后端未就绪或短暂断开时忽略
  })
}

function applyBodyControl(command) {
  if (!command || typeof command !== 'object') return
  if (!win || win.isDestroyed()) createWindow()
  if (!win || win.isDestroyed()) return

  let uiChanged = false
  if (typeof command.showText === 'boolean') {
    settings.showTextAndControls = command.showText
    uiChanged = true
  }
  if (typeof command.showComposer === 'boolean') {
    settings.showComposer = command.showComposer
    uiChanged = true
  }

  if (typeof command.scale === 'number' && Number.isFinite(command.scale)) {
    setWindowScale(command.scale)
    uiChanged = true
  }

  if (uiChanged) {
    saveSettings()
    sendUiState(true)
    rebuildTrayMenu()
  }

  if (typeof command.visible === 'boolean') {
    if (command.visible) {
      windowHiddenByUser = false
      restoreWindowPresence()
    } else {
      windowHiddenByUser = true
      cancelSmoothMove()
      win.hide()
    }
    rebuildTrayMenu()
  }

  const bounds = win.getBounds()
  const { workArea } = screen.getPrimaryDisplay()
  let targetX = bounds.x
  let targetY = bounds.y
  let hasPositionChange = false

  if (typeof command.preset === 'string') {
    const pos = computePresetPosition(command.preset, bounds, workArea)
    targetX = pos.x
    targetY = pos.y
    hasPositionChange = true
  }
  if (typeof command.x === 'number' && Number.isFinite(command.x)) {
    targetX = Math.round(command.x)
    hasPositionChange = true
  }
  if (typeof command.y === 'number' && Number.isFinite(command.y)) {
    targetY = Math.round(command.y)
    hasPositionChange = true
  }
  if (typeof command.dx === 'number' && Number.isFinite(command.dx)) {
    targetX += Math.round(command.dx)
    hasPositionChange = true
  }
  if (typeof command.dy === 'number' && Number.isFinite(command.dy)) {
    targetY += Math.round(command.dy)
    hasPositionChange = true
  }

  if (hasPositionChange) {
    const clamped = clampPartiallyVisible(targetX, targetY, bounds.width, bounds.height, workArea)
    reportBodyState(command.requestId, { x: clamped.x, y: clamped.y })
    animateWindowPosition(clamped.x, clamped.y, 300)
  } else {
    reportBodyState(command.requestId)
  }
}

function startWindowDrag() {
  if (!win || dragState) return
  cancelSmoothMove()
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = win.getPosition()
  dragState = { cursorX: cursor.x, cursorY: cursor.y, x, y }
  rendererIgnoreMouse = false
  applyMouseIgnore()
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(moveWindowDrag, 16)
  if (dragSafety) clearTimeout(dragSafety)
  dragSafety = setTimeout(endWindowDrag, 60_000)
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] drag start:', dragState)
  }
}

function moveWindowDrag() {
  if (!win || !dragState) return
  const cursor = screen.getCursorScreenPoint()
  const x = dragState.x + cursor.x - dragState.cursorX
  const y = dragState.y + cursor.y - dragState.cursorY
  win.setPosition(Math.round(x), Math.round(y), false)
}

function endWindowDrag() {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  if (dragSafety) {
    clearTimeout(dragSafety)
    dragSafety = null
  }
  if (dragState) {
    dragState = null
    if (process.env.EH_PET_DEBUG) console.log('[pet] drag end')
    reportBodyState()
  }
}

function setWindowScale(percent) {
  if (!win) return
  const factor = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(percent) / 100))
  if (!Number.isFinite(factor)) return
  currentScalePercent = Math.round(factor * 100)

  const old = win.getBounds()
  const width = old.width
  const height = Math.max(420, Math.round(BASE_HEIGHT * factor))
  const x = old.x
  const y = old.y + old.height - height
  win.setBounds({ x, y, width, height }, false)
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] size:', percent, { x, y, width, height })
  }
  reportBodyState()
}

function resetWindowPosition() {
  if (!win) return
  cancelSmoothMove()
  const { workArea } = screen.getPrimaryDisplay()
  const [width, height] = win.getSize()
  const x = Math.max(workArea.x, workArea.x + workArea.width - width - 24)
  const y = Math.max(workArea.y, workArea.y + workArea.height - height - 24)
  win.setPosition(Math.round(x), Math.round(y), false)
  windowHiddenByUser = false
  restoreWindowPresence()
  reportBodyState()
}

function toggleClickThrough() {
  settings.clickThrough = !settings.clickThrough
  saveSettings()
  sendUiState()
  applyMouseIgnore()
  rebuildTrayMenu()
  reportBodyState()
}

function toggleTextControls() {
  settings.showTextAndControls = !settings.showTextAndControls
  saveSettings()
  sendUiState()
  rebuildTrayMenu()
  reportBodyState()
}

function toggleComposer() {
  settings.showComposer = !settings.showComposer
  saveSettings()
  sendUiState()
  rebuildTrayMenu()
  reportBodyState()
}

function unregisterAllShortcuts() {
  for (const accelerator of Object.values(registeredShortcuts)) {
    try {
      if (accelerator) globalShortcut.unregister(accelerator)
    } catch {
      // 忽略未注册成功的组合
    }
  }
  registeredShortcuts = {}
}

function validateShortcut(accelerator) {
  if (!accelerator) return ''
  const parts = accelerator.split('+')
  const modifiers = parts.slice(0, -1)
  if (parts.length < 2) return '需要修饰键和一个按键'
  if (!modifiers.some(modifier => ['Command', 'Control', 'Alt', 'CommandOrControl', 'Super'].includes(modifier))) {
    return '至少需要 Command、Control 或 Alt'
  }
  return ''
}

function applyShortcuts() {
  unregisterAllShortcuts()
  const errors = []
  const seen = new Map()

  for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
    const accelerator = String(settings.shortcuts[action] ?? '').trim()
    if (!accelerator) continue

    const validation = validateShortcut(accelerator)
    if (validation) {
      errors.push(`${label}：${validation}`)
      continue
    }
    if (seen.has(accelerator)) {
      errors.push(`${label}：与「${SHORTCUT_LABELS[seen.get(accelerator)]}」重复`)
      continue
    }
    seen.set(accelerator, action)

    let registered = false
    try {
      registered = globalShortcut.register(accelerator, shortcutActions[action])
    } catch {
      registered = false
    }
    if (registered) registeredShortcuts[action] = accelerator
    else errors.push(`${label}：${accelerator} 注册失败，可能被其他应用占用`)
  }

  shortcutErrors = errors
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] shortcuts:', registeredShortcuts, errors)
  }
  return errors
}

const shortcutActions = {
  toggleClickThrough,
  toggleWindow: () => toggleWindow(),
  toggleTextControls,
  toggleComposer,
}

function testShortcuts(shortcuts) {
  const errors = []
  const registered = []
  const seen = new Map()

  for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
    const accelerator = String(shortcuts[action] ?? '').trim()
    if (!accelerator) continue

    const validation = validateShortcut(accelerator)
    if (validation) {
      errors.push(`${label}：${validation}`)
      continue
    }
    if (seen.has(accelerator)) {
      errors.push(`${label}：与「${SHORTCUT_LABELS[seen.get(accelerator)]}」重复`)
      continue
    }
    seen.set(accelerator, action)

    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => undefined)
    } catch {
      ok = false
    }
    if (ok) registered.push(accelerator)
    else errors.push(`${label}：${accelerator} 注册失败，可能被其他应用占用`)
  }

  for (const accelerator of registered) {
    try { globalShortcut.unregister(accelerator) } catch { /* 忽略 */ }
  }
  return errors
}

function saveShortcutSettings(input) {
  const next = {}
  for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
    next[key] = input && typeof input[key] === 'string' ? input[key].trim() : ''
  }

  const errors = testShortcuts(next)
  if (errors.length > 0) {
    return { ok: false, error: errors.join('\n') }
  }

  settings.shortcuts = next
  saveSettings()
  rebuildTrayMenu()
  return { ok: true, shortcuts: { ...next } }
}

function openShortcutSettings() {
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }

  // 录制时先停掉所有全局快捷键，避免按到旧组合就触发动作
  unregisterAllShortcuts()
  shortcutErrors = []

  settingsWin = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '快捷键设置',
    backgroundColor: '#11131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.center()
  settingsWin.once('ready-to-show', () => {
    if (!settingsWin) return
    settingsWin.show()
    settingsWin.focus()
  })
  settingsWin.on('closed', () => {
    settingsWin = null
    if (!isQuitting) {
      shortcutErrors = applyShortcuts()
      rebuildTrayMenu()
    }
  })
  settingsWin.loadFile(SHORTCUTS_FILE).catch(error => {
    if (process.env.EH_PET_DEBUG) console.error('[pet] shortcuts window load failed:', error.message)
  })
}

function startGlobalVoiceHotkey(prompt = false) {
  if (globalVoiceEnabled) return true
  if (!globalKeyHook || !globalKeyCodes) {
    globalVoiceError = 'uiohook-napi 不可用'
    rebuildTrayMenu()
    return false
  }

  if (process.platform === 'darwin') {
    if (process.env.EH_PET_DEBUG) console.log('[pet] global voice: checking accessibility')
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(Boolean(prompt))
    } catch {
      trusted = false
    }
    if (!trusted) {
      globalVoicePermissionNeeded = true
      globalVoiceError = '需要辅助功能权限'
      rebuildTrayMenu()
      return false
    }
  }

  try {
    if (process.env.EH_PET_DEBUG) console.log('[pet] global voice: starting hook')
    if (!globalVoiceHookAttached) {
      globalKeyHook.on('keydown', handleGlobalVoiceKeyDown)
      globalKeyHook.on('keyup', handleGlobalVoiceKeyUp)
      globalVoiceHookAttached = true
    }
    globalKeyHook.start()
    globalVoiceEnabled = true
    globalVoicePermissionNeeded = false
    globalVoiceError = ''
    if (process.env.EH_PET_DEBUG) console.log('[pet] global voice hotkey enabled')
    sendVoiceHotkeyMode()
    rebuildTrayMenu()
    return true
  } catch (error) {
    globalVoiceError = error instanceof Error ? error.message : String(error)
    if (process.env.EH_PET_DEBUG) console.log('[pet] global voice hotkey failed:', globalVoiceError)
    rebuildTrayMenu()
    return false
  }
}

function stopGlobalVoiceHotkey() {
  if (globalKeyHook && globalVoiceEnabled) {
    try {
      globalKeyHook.stop()
    } catch {
      // 已经停了
    }
  }
  globalVoiceEnabled = false
  cancelVoiceArm()
  voiceControlDown = false
  voiceMetaDown = false
  voiceActive = false
  sendVoiceHotkeyMode()
}

function requestGlobalVoiceHotkey() {
  const ok = startGlobalVoiceHotkey(true)
  if (!ok && process.platform === 'darwin' && globalVoicePermissionNeeded) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  }
  rebuildTrayMenu()
}

function isGlobalControlKey(code) {
  return code === globalKeyCodes?.Ctrl || code === globalKeyCodes?.CtrlRight
}

function isGlobalMetaKey(code) {
  return code === globalKeyCodes?.Meta || code === globalKeyCodes?.MetaRight
}

function handleGlobalVoiceKeyDown(event) {
  if (!globalVoiceEnabled) return
  const code = event.keycode

  if (isGlobalControlKey(code)) {
    voiceControlDown = true
    if (process.env.EH_PET_DEBUG) console.log('[pet] global keydown: control')
  } else if (isGlobalMetaKey(code)) {
    voiceMetaDown = true
    if (process.env.EH_PET_DEBUG) console.log('[pet] global keydown: meta')
  } else {
    // 180ms 保护期内按下其他键，说明这不是“按住 Control + Command 说话”。
    if (voiceArming) {
      if (process.env.EH_PET_DEBUG) console.log('[pet] global voice: canceled by other key')
      cancelVoiceArm()
    }
    return
  }

  if (!voiceArming && !voiceActive && voiceControlDown && voiceMetaDown) {
    armGlobalVoice()
  }
}

function handleGlobalVoiceKeyUp(event) {
  if (!globalVoiceEnabled) return
  const code = event.keycode

  if (isGlobalControlKey(code)) {
    voiceControlDown = false
    if (process.env.EH_PET_DEBUG) console.log('[pet] global keyup: control')
  } else if (isGlobalMetaKey(code)) {
    voiceMetaDown = false
    if (process.env.EH_PET_DEBUG) console.log('[pet] global keyup: meta')
  } else {
    return
  }

  if (voiceArming) {
    cancelVoiceArm()
    return
  }

  if (voiceActive) stopGlobalVoiceRecording()
}

function armGlobalVoice() {
  if (voiceArming || voiceActive) return
  voiceArming = true
  voiceArmTimer = setTimeout(() => {
    voiceArmTimer = null
    if (!voiceArming) return
    voiceArming = false
    if (!voiceControlDown || !voiceMetaDown) return

    voiceActive = true
    setTrayVoiceState('recording')
    if (process.env.EH_PET_DEBUG) console.log('[pet] global voice start')
    sendVoiceStart()
  }, 180)
}

function cancelVoiceArm() {
  voiceArming = false
  if (voiceArmTimer) {
    clearTimeout(voiceArmTimer)
    voiceArmTimer = null
  }
}

function stopGlobalVoiceRecording() {
  if (!voiceActive) return
  voiceActive = false
  setTrayVoiceState('processing')
  if (process.env.EH_PET_DEBUG) console.log('[pet] global voice stop')
  sendVoiceStop()
}

function sendVoiceStart() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:voice-start')
}

function sendVoiceStop() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:voice-stop')
}

function sendVoiceHotkeyMode() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:voice-hotkey-mode', { enabled: globalVoiceEnabled })
}

function setTrayVoiceState(state) {
  trayVoiceState = state
  if (!tray || process.platform !== 'darwin') return
  try {
    tray.setTitle(state === 'recording' ? '🎙' : state === 'processing' ? '…' : '')
  } catch {
    // 托盘标题不可用不影响录音
  }
}

function createTray() {
  let icon = nativeImage.createEmpty()
  if (fs.existsSync(TRAY_ICON)) {
    icon = nativeImage.createFromPath(TRAY_ICON)
    if (!icon.isEmpty()) icon.setTemplateImage(true)
  }
  tray = new Tray(icon)
  tray.setToolTip('Elio')
  if (icon.isEmpty()) tray.setTitle('E')
  rebuildTrayMenu()
}

function rebuildTrayMenu() {
  if (!tray) return
  const visible = Boolean(win && win.isVisible())
  const template = [
    {
      label: visible ? '隐藏 Elio' : '显示 Elio',
      click: toggleWindow,
    },
    { type: 'separator' },
    {
      label: '显示文字和进度条',
      type: 'checkbox',
      checked: settings.showTextAndControls,
      click: item => {
        settings.showTextAndControls = item.checked
        saveSettings()
        sendUiState()
        rebuildTrayMenu()
      },
    },
    {
      label: '显示输入框',
      type: 'checkbox',
      checked: settings.showComposer,
      click: item => {
        settings.showComposer = item.checked
        saveSettings()
        sendUiState()
        rebuildTrayMenu()
      },
    },
    {
      label: '点击穿透',
      type: 'checkbox',
      checked: settings.clickThrough,
      click: item => {
        settings.clickThrough = item.checked
        saveSettings()
        sendUiState()
        applyMouseIgnore()
        rebuildTrayMenu()
      },
    },
    {
      label: globalVoiceEnabled
        ? '全局语音快捷键：已启用'
        : globalVoicePermissionNeeded
          ? '启用全局语音快捷键（需要辅助功能权限）…'
          : '启用全局语音快捷键…',
      enabled: !globalVoiceEnabled,
      click: requestGlobalVoiceHotkey,
    },
    { type: 'separator' },
    {
      label: '设置快捷键…',
      click: openShortcutSettings,
    },
    { type: 'separator' },
    {
      label: '重新连接',
      click: loadStage,
    },
    {
      label: '回到右下角',
      click: resetWindowPosition,
    },
    {
      label: '打开网页舞台',
      click: () => shell.openExternal('http://127.0.0.1:8099/stage'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

ipcMain.on('pet:set-ignore-mouse', (event, ignore) => {
  if (!win || event.sender !== win.webContents) return
  rendererIgnoreMouse = Boolean(ignore)
  applyMouseIgnore()
})

ipcMain.on('pet:drag-start', event => {
  if (!win || event.sender !== win.webContents) return
  startWindowDrag()
})

ipcMain.on('pet:drag-end', event => {
  if (!win || event.sender !== win.webContents) return
  endWindowDrag()
})

ipcMain.on('pet:set-scale', (event, percent) => {
  if (!win || event.sender !== win.webContents) return
  setWindowScale(percent)
})

ipcMain.on('pet:voice-state', (event, state) => {
  if (!win || event.sender !== win.webContents) return
  if (state !== 'idle' && state !== 'recording' && state !== 'processing') return
  setTrayVoiceState(state)
})

ipcMain.on('pet:retry', event => {
  if (!win || event.sender !== win.webContents) return
  loadStage()
})

ipcMain.handle('pet:body-control', (event, command) => {
  if (win && event.sender !== win.webContents) return false
  applyBodyControl(command)
  return true
})

ipcMain.handle('pet:request-microphone', async () => {
  if (process.platform !== 'darwin') return true
  try {
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    return false
  }
})

ipcMain.handle('pet:get-shortcuts', () => ({
  shortcuts: { ...settings.shortcuts },
  errors: [...shortcutErrors],
}))

ipcMain.handle('pet:save-shortcuts', (_event, input) => saveShortcutSettings(input))

ipcMain.on('pet:close-shortcuts', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
})

function captureForDebug() {
  if (!win || !process.env.EH_PET_SCREENSHOT || screenshotDone) return
  screenshotDone = true
  const delay = Number(process.env.EH_PET_SCREENSHOT_DELAY || 1200)
  setTimeout(async () => {
    if (!win) return
    try {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(process.env.EH_PET_SCREENSHOT, image.toPNG())
      console.log('[pet] screenshot:', process.env.EH_PET_SCREENSHOT)
    } catch (error) {
      console.error('[pet] screenshot failed:', error)
    }
    if (process.env.EH_PET_SCREENSHOT_EXIT === '1') app.quit()
  }, Math.max(0, delay))
}
