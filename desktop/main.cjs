'use strict'

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell, session, globalShortcut } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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
let rendererIgnoreMouse = false
let screenshotDone = false
let dragState = null
let dragTimer = null
let dragSafety = null
let registeredShortcuts = {}
let shortcutErrors = []
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

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    applyShortcuts()
    createTray()
    createWindow()

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

  win.setAlwaysOnTop(true, 'floating')

  win.once('ready-to-show', () => {
    if (!win) return
    win.showInactive()
    if (process.env.EH_PET_DEBUG) {
      console.log('[pet] window:', win.getBounds())
      console.log('[pet] window type:', 'panel')
      console.log('[pet] always on top:', win.isAlwaysOnTop())
      console.log('[pet] dock visible:', process.platform === 'darwin' ? app.dock.isVisible() : 'n/a')
    }
    captureForDebug()
  })

  win.on('show', rebuildTrayMenu)
  win.on('hide', () => {
    endWindowDrag()
    rebuildTrayMenu()
  })

  win.on('blur', endWindowDrag)

  win.on('close', event => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    endWindowDrag()
    win = null
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

  win.webContents.on('did-finish-load', sendUiState)

  loadStage()
}

function showWindow() {
  if (!win) {
    createWindow()
    return
  }
  win.show()
  win.focus()
}

function toggleWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isVisible()) win.hide()
  else win.showInactive()
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

function sendUiState() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:ui-state', {
    showTextAndControls: settings.showTextAndControls,
    showComposer: settings.showComposer,
    clickThrough: settings.clickThrough,
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

function startWindowDrag() {
  if (!win || dragState) return
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
  }
}

function setWindowScale(percent) {
  if (!win) return
  const factor = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(percent) / 100))
  if (!Number.isFinite(factor)) return

  const old = win.getBounds()
  const width = old.width
  const height = Math.max(420, Math.round(BASE_HEIGHT * factor))
  const x = old.x
  const y = old.y + old.height - height
  win.setBounds({ x, y, width, height }, false)
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] size:', percent, { x, y, width, height })
  }
}

function resetWindowPosition() {
  if (!win) return
  const { workArea } = screen.getPrimaryDisplay()
  const [width, height] = win.getSize()
  const x = Math.max(workArea.x, workArea.x + workArea.width - width - 24)
  const y = Math.max(workArea.y, workArea.y + workArea.height - height - 24)
  win.setPosition(Math.round(x), Math.round(y), false)
  if (!win.isVisible()) win.showInactive()
}

function toggleClickThrough() {
  settings.clickThrough = !settings.clickThrough
  saveSettings()
  sendUiState()
  applyMouseIgnore()
  rebuildTrayMenu()
}

function toggleTextControls() {
  settings.showTextAndControls = !settings.showTextAndControls
  saveSettings()
  sendUiState()
  rebuildTrayMenu()
}

function toggleComposer() {
  settings.showComposer = !settings.showComposer
  saveSettings()
  sendUiState()
  rebuildTrayMenu()
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

ipcMain.on('pet:retry', event => {
  if (!win || event.sender !== win.webContents) return
  loadStage()
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
