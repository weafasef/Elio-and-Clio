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
const TRAY_ICON = path.join(__dirname, 'trayTemplate.png')
const SHORTCUT = 'CommandOrControl+Shift+E'

let win = null
let tray = null
let isQuitting = false
let forceInteractive = false
let rendererIgnoreMouse = false
let screenshotDone = false
let dragState = null
let dragTimer = null
let dragSafety = null

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  app.whenReady().then(() => {
    app.setName('Elio')

    if (process.platform === 'darwin' && !process.env.EH_PET_KEEP_DOCK) {
      app.dock.hide()
    }

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    registerShortcut()
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
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })

  win.once('ready-to-show', () => {
    if (!win) return
    win.showInactive()
    if (process.env.EH_PET_DEBUG) {
      console.log('[pet] window:', win.getBounds())
      console.log('[pet] always on top:', win.isAlwaysOnTop())
      console.log('[pet] all workspaces:', win.isVisibleOnAllWorkspaces())
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

function applyMouseIgnore() {
  if (!win) return
  const ignore = forceInteractive ? false : rendererIgnoreMouse
  win.setIgnoreMouseEvents(ignore, { forward: true })
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] ignore mouse:', ignore, 'force:', forceInteractive)
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
  const display = screen.getDisplayNearestPoint(cursor)
  const area = display.workArea
  const [width, height] = win.getSize()
  const minX = area.x
  const minY = area.y
  const maxX = Math.max(minX, area.x + area.width - width)
  const maxY = Math.max(minY, area.y + area.height - height)
  const x = Math.min(Math.max(dragState.x + cursor.x - dragState.cursorX, minX), maxX)
  const y = Math.min(Math.max(dragState.y + cursor.y - dragState.cursorY, minY), maxY)
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
  const display = screen.getDisplayMatching(old)
  const area = display.workArea
  const width = old.width
  const height = Math.min(Math.max(420, Math.round(BASE_HEIGHT * factor)), Math.max(420, area.height - 8))
  const bottom = old.y + old.height
  const x = Math.max(area.x, Math.min(old.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(bottom - height, area.y + area.height - height))
  win.setBounds({ x, y, width, height }, false)
  if (process.env.EH_PET_DEBUG) {
    console.log('[pet] size:', percent, { x, y, width, height })
  }
}

function registerShortcut() {
  const registered = globalShortcut.register(SHORTCUT, () => {
    forceInteractive = !forceInteractive
    applyMouseIgnore()
    rebuildTrayMenu()
  })
  if (!registered) {
    console.warn(`[pet] shortcut not registered: ${SHORTCUT}`)
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
      label: '强制交互',
      type: 'checkbox',
      checked: forceInteractive,
      click: item => {
        forceInteractive = item.checked
        applyMouseIgnore()
        rebuildTrayMenu()
      },
    },
    {
      label: '重新连接',
      click: loadStage,
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
