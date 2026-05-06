import { app, BrowserWindow, nativeTheme, shell, Tray, Menu, nativeImage, ipcMain } from 'electron'
import { join } from 'path'
import { getDb, closeDb } from './db/database'
import { registerIpcHandlers } from './ipc-router'
import { SchedulerService } from './scheduler/SchedulerService'
import { SearchIndexService } from './services/SearchIndexService'
import { IPC } from '@shared/ipc-channels'
import { GongScraperService } from './services/GongScraperService'
import { startNotificationScheduler, stopNotificationScheduler } from './services/NotificationSchedulerService'

// ─── Auto-updater ─────────────────────────────────────────────────────────────
// Only active in packaged builds — never crashes the dev server.
let autoUpdater: import('electron-updater').AppUpdater | null = null
if (app.isPackaged) {
  try {
    const { autoUpdater: updater } = require('electron-updater') as typeof import('electron-updater')
    autoUpdater = updater
    updater.logger = null          // silence verbose log spam; swap for electron-log if desired
    updater.autoDownload = true    // silently download in background
    updater.autoInstallOnAppQuit = true  // install on next quit

    updater.on('checking-for-update', () => {
      mainWindow?.webContents.send(IPC.PUSH_UPDATE_STATUS, { status: 'checking' })
    })
    updater.on('update-available', () => {
      mainWindow?.webContents.send(IPC.PUSH_UPDATE_STATUS, { status: 'available', message: 'Downloading update…' })
    })
    updater.on('update-not-available', () => {
      mainWindow?.webContents.send(IPC.PUSH_UPDATE_STATUS, { status: 'not-available', message: 'You\'re on the latest version.' })
    })
    updater.on('update-downloaded', () => {
      mainWindow?.webContents.send(IPC.PUSH_UPDATE_STATUS, { status: 'downloaded', message: 'Update ready — quit and relaunch to install.' })
    })
    updater.on('error', (err: Error) => {
      mainWindow?.webContents.send(IPC.PUSH_UPDATE_STATUS, { status: 'error', message: err.message })
      console.warn('[updater] error:', err.message)
    })
  } catch (err) {
    console.warn('[updater] electron-updater not available:', err)
  }
}

// ─── Dev-mode HMR reload ──────────────────────────────────────────────────────
if (!app.isPackaged) {
  // electron-vite injects ELECTRON_RENDERER_URL in dev mode
}

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

// ─── Window + Tray ────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

function createWindow(): void {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  1024,
    minHeight: 700,
    title:     'B.O.B.',
    backgroundColor: '#0D1525',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    show: false,
    webPreferences: {
      preload:          join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  // Show window immediately, then init everything else in the background
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (!app.isPackaged) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
    // All heavy init runs after the window is visible and painted
    setImmediate(() => {
      getDb()
      registerIpcHandlers()
      SchedulerService.init()
      SearchIndexService.seedKnowledge()
      startNotificationScheduler()
      // Check for updates ~10 seconds after startup (gives the window time to fully load)
      if (autoUpdater) setTimeout(() => autoUpdater!.checkForUpdatesAndNotify().catch(() => {}), 10_000)
    })
  })

  // Open external links in the OS browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function pushNavigate(path: string): void {
  mainWindow?.show()
  mainWindow?.focus()
  mainWindow?.webContents.send(IPC.PUSH_NAVIGATE, { path })
}

function buildTrayMenu(): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = []

  // Next calendar event (best-effort — DB may not be ready yet)
  try {
    const db = getDb()
    const now = new Date().toISOString()
    const next = db.prepare(
      `SELECT title, start_at FROM calendar_events WHERE start_at >= ? ORDER BY start_at ASC LIMIT 1`
    ).get(now) as { title: string; start_at: string } | undefined
    if (next) {
      const dt = new Date(next.start_at)
      const label = `Next: ${next.title} — ${dt.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      items.push({ label, enabled: false })
      items.push({ type: 'separator' })
    }
  } catch { /* DB not ready yet */ }

  items.push(
    {
      label: 'Open B.O.B.',
      click: () => { mainWindow?.show(); mainWindow?.focus() },
    },
    { type: 'separator' },
    {
      label: 'Open Spreadsheet',
      click: () => pushNavigate('/transcripts'),
    },
    {
      label: 'Run All Processes',
      click: () => {
        pushNavigate('/transcripts')
        GongScraperService.doRunAll().catch(console.error)
      },
    },
    {
      label: 'Rescrub Company List',
      click: () => {
        pushNavigate('/transcripts')
        GongScraperService.doStep1().catch(console.error)
      },
    },
    { label: 'Open Company List', click: () => pushNavigate('/companies') },
    { type: 'separator' },
    { label: 'Sync Calendar',     click: () => pushNavigate('/calendar') },
    { label: 'Open Calendar',     click: () => pushNavigate('/calendar') },
    { type: 'separator' },
    {
      label: 'Scrub Gong Only',
      click: () => {
        pushNavigate('/transcripts')
        GongScraperService.doStep2().catch(console.error)
      },
    },
    {
      label: 'Organize Transcripts',
      click: () => {
        pushNavigate('/transcripts')
        GongScraperService.doStep3().catch(console.error)
      },
    },
    { type: 'separator' },
    { label: 'Open Flyer Creator',       click: () => pushNavigate('/flyer') },
    { label: 'Open Prompt Library',      click: () => pushNavigate('/prompts') },
    { label: 'Open Scrub & Split',       click: () => pushNavigate('/scrub') },
    { label: 'Open Knowledge Assistant', click: () => pushNavigate('/assistant') },
    { label: 'Open Settings',            click: () => pushNavigate('/settings') },
    { type: 'separator' },
    { label: 'Quit B.O.B.', role: 'quit' },
  )

  return Menu.buildFromTemplate(items)
}

function createTray(): void {
  if (process.platform !== 'darwin') return  // macOS only

  // electron-builder copies resources/ → Contents/Resources/resources/ (subfolder).
  // In dev, __dirname = out/main/ so ../../resources is the project resources/ folder.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'pklines_tray.png')
    : join(__dirname, '../../resources/pklines_tray.png')

  const img = nativeImage.createFromPath(iconPath)
  // Resize to 16×16 — standard macOS menu bar icon size.
  // setTemplateImage must be called on the resized copy, not the original.
  const icon = img.resize({ width: 16, height: 16 })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('B.O.B. — CSM Master Tool')

  // Build menu lazily each time it opens so "Next:" is always fresh
  tray.on('right-click', () => {
    tray?.setContextMenu(buildTrayMenu())
    tray?.popUpContextMenu()
  })

  // Left-click: show/focus the window
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })

  // Initial menu so right-click shows something immediately
  tray.setContextMenu(buildTrayMenu())
}

// ─── Update IPC ──────────────────────────────────────────────────────────────
ipcMain.handle(IPC.APP_CHECK_UPDATES, async () => {
  if (!autoUpdater) {
    return { ok: true, data: { status: 'error', message: 'Auto-updater not available in dev mode.' } }
  }
  try {
    await autoUpdater.checkForUpdatesAndNotify()
    return { ok: true, data: { status: 'checking' } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: true, data: { status: 'error', message: msg } }
  }
})

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Dock icon is set by icon.icns embedded in the app bundle by electron-builder.
  // No runtime override needed — the .icns generated by Swift preserves transparency.

  // Create the window immediately so it appears as fast as possible
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    mainWindow?.show()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  // On macOS, keep the app alive in the tray even when all windows are closed.
  // On other platforms, quit normally.
  if (process.platform !== 'darwin') {
    SchedulerService.destroy()
    closeDb()
    app.quit()
  }
})

app.on('before-quit', () => {
  SchedulerService.destroy()
  stopNotificationScheduler()
  closeDb()
})

// ─── Export window accessor for push events ───────────────────────────────────
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
