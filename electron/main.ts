import { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog, screen, powerSaveBlocker, globalShortcut } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { AppSettings, CaptureInfo, CaptureSource, PCMChunk, qualityPresets } from '../src/recording'
import { NativeRecorder, listNativeDisplays, locateNativeWindows } from './native-recorder'
import { BrowserRecorder } from './browser-recorder'
import { exportRecording } from './export-recording'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null
let overlayWin: BrowserWindow | null = null
let nativeRecorder: NativeRecorder | null = null
let browserRecorder: BrowserRecorder | null = null
let recordingBusy = false
let exporting = false
let sleepBlocker: number | undefined
let quitAfterSave = false
let diskTimer: ReturnType<typeof setInterval> | undefined
const displayHelper = app.isPackaged ? path.join(process.resourcesPath, 'windows-displays.exe')
  : path.join(__dirname, '../native/bin/windows-displays.exe')

function releaseRecording() {
  nativeRecorder = null
  browserRecorder = null
  recordingBusy = false
  clearInterval(diskTimer)
  diskTimer = undefined
  closeOverlayWindow()
  if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker)
  sleepBlocker = undefined
  if (win?.isMinimized()) win.restore()
  if (quitAfterSave) app.quit()
}

function claimRecording() {
  if (recordingBusy || exporting) throw new Error('Another recording or export is still active')
  recordingBusy = true
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep')
}

async function watchDisk(folder: string) {
  await fs.promises.mkdir(folder, { recursive: true })
  const freeBytes = async () => {
    const stat = await fs.promises.statfs(folder)
    return stat.bavail * stat.bsize
  }
  if (await freeBytes() < 512 * 1024 * 1024) throw new Error('Less than 512 MB is free in the recording folder. Free some space before recording.')
  diskTimer = setInterval(() => {
    void freeBytes().then(bytes => {
      if (bytes >= 512 * 1024 * 1024) return
      clearInterval(diskTimer)
      win?.webContents.send('recording-error', 'Recording stopped because less than 512 MB of disk space remains.')
    }).catch(error => {
      win?.webContents.send('recording-error', `The recording drive is unavailable: ${String(error)}`)
    })
  }, 3000)
}

// Settings storage
const settingsPath = path.join(app.getPath('userData'), 'settings.json')

const defaultSettings: AppSettings = {
  outputFolder: path.join(app.getPath('videos'), 'SleekRecordings'),
  qualityPreset: 'medium',
  recordingEngine: 'auto',
  frameRate: 'display',
  nativeCodec: 'h264',
  systemAudio: true,
  columnCount: 2,
  micEnabled: false,
  micDeviceId: null,
  micVolume: 0.8,
  micRawInput: false
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8')
      return normalizeSettings(JSON.parse(data))
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return { ...defaultSettings }
}

function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const s = { ...defaultSettings, ...input }
  if (!['low', 'medium', 'high', 'ultra'].includes(s.qualityPreset)) s.qualityPreset = 'medium'
  if (!['auto', 'native', 'browser'].includes(s.recordingEngine)) s.recordingEngine = 'auto'
  if (!['display', 30, 60, 90, 120, 144, 165, 240].includes(s.frameRate)) s.frameRate = 'display'
  if (!['h264', 'hevc'].includes(s.nativeCodec)) s.nativeCodec = 'h264'
  if (typeof s.outputFolder !== 'string' || !path.isAbsolute(s.outputFolder)) s.outputFolder = defaultSettings.outputFolder
  s.micVolume = Number.isFinite(s.micVolume) ? Math.min(1.5, Math.max(0, s.micVolume)) : 0.8
  s.micDeviceId = typeof s.micDeviceId === 'string' ? s.micDeviceId : null
  for (const key of ['systemAudio', 'micEnabled', 'micRawInput'] as const) {
    if (typeof s[key] !== 'boolean') s[key] = defaultSettings[key]
  }
  if (![2, 3, 4].includes(s.columnCount)) s.columnCount = 2
  return s
}

function saveSettings(settings: Partial<AppSettings>) {
  try {
    const current = loadSettings()
    const updated = normalizeSettings({ ...current, ...settings })
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2))
    return updated
  } catch (e) {
    console.error('Failed to save settings:', e)
    throw e
  }
}

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(process.env.VITE_PUBLIC || '', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // Prevent stopping when minimized
    },
    // Modern sleek look - platform-specific title bar
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {
      trafficLightPosition: { x: 15, y: 15 }
    } : {
      titleBarOverlay: {
        color: '#121212',
        symbolColor: '#ffffff',
        height: 30
      }
    })
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(process.env.DIST || '', 'index.html'))
  }
  win.on('close', event => {
    if (recordingBusy || exporting) {
      event.preventDefault()
      if (recordingBusy) win?.webContents.send('stop-recording')
    }
  })
  win.webContents.on('render-process-gone', () => {
    void (nativeRecorder?.abort() ?? browserRecorder?.abort() ?? Promise.resolve()).finally(releaseRecording)
  })
}

function createOverlayWindow() {
  if (overlayWin) {
    overlayWin.show()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width } = primaryDisplay.workAreaSize
  const isMac = process.platform === 'darwin'

  overlayWin = new BrowserWindow({
    width: 320,
    height: 70,
    x: width - 340,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    hasShadow: false,
    ...(isMac && { vibrancy: 'under-window' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    }
  })

  // Make visible on all workspaces/desktops
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setAlwaysOnTop(true, 'floating', 1)
  overlayWin.setContentProtection(true)

  if (VITE_DEV_SERVER_URL) {
    overlayWin.loadURL(`${VITE_DEV_SERVER_URL}overlay.html`)
  } else {
    overlayWin.loadFile(path.join(process.env.DIST || '', 'overlay.html'))
  }

  overlayWin.on('closed', () => {
    overlayWin = null
  })
}

function closeOverlayWindow() {
  if (overlayWin) {
    overlayWin.close()
    overlayWin = null
  }
}

app.on('window-all-closed', () => {
  win = null
  app.quit()
})

app.whenReady().then(() => {
  createWindow()
  globalShortcut.register('CommandOrControl+Shift+F9', () => win?.webContents.send('stop-recording'))
  globalShortcut.register('CommandOrControl+Shift+F10', () => win?.webContents.send('pause-recording'))

})

app.on('before-quit', event => {
  if (recordingBusy || exporting) {
    event.preventDefault()
    quitAfterSave = true
    if (recordingBusy) win?.webContents.send('stop-recording')
  }
})
app.on('will-quit', () => globalShortcut.unregisterAll())


async function captureSources(): Promise<CaptureSource[]> {
  const [sources, nativeDisplays] = await Promise.all([
    desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 480, height: 270 } }),
    listNativeDisplays(displayHelper)
  ])
  const displays = screen.getAllDisplays()
  const windows = await locateNativeWindows(displayHelper, sources.map(source => source.id))
  const result: CaptureSource[] = sources.map(source => {
    const display = source.id.startsWith('screen:') ? displays.find(d => String(d.id) === source.display_id) : undefined
    const rect = display && process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : undefined
    const nativeDisplay = rect ? nativeDisplays.find(d => d.x === rect.x && d.y === rect.y &&
      d.width === rect.width && d.height === rect.height && d.nvidia && d.defaultAdapter && d.rotation <= 1) : undefined
    return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), nativeDisplay,
      ...(process.platform === 'win32' && source.id.startsWith('screen:') && !nativeDisplay ? {
        gpuUnavailableReason: 'GPU capture could not be matched to this screen. Refresh the sources and check the display connection. Choose Browser explicitly in Settings to use the slower recorder.'
      } : {}),
      ...(display ? { width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor), refreshRate: display.displayFrequency } : {}) }
  })
  for (const source of result) {
    const handle = /^window:(\d+):/.exec(source.id)?.[1]
    const window = windows.find(w => w.handle === handle)
    if (!window) continue
    const display = nativeDisplays.find(d => d.x === window.x && d.y === window.y)
    const monitor = display && result.find(s => s.nativeDisplay === display)
    source.refreshRate = display?.refreshRate
    // This is only a recommendation: choosing a window must never silently
    // widen capture to include everything else visible on the monitor.
    source.recommendedScreenId = monitor?.id
  }
  return result.sort((a, b) => Number(!!b.nativeDisplay) - Number(!!a.nativeDisplay) ||
    Number(b.id.startsWith('screen:')) - Number(a.id.startsWith('screen:')) ||
    (b.refreshRate || 0) - (a.refreshRate || 0))
}

ipcMain.handle('get-sources', captureSources)
ipcMain.handle('native-capabilities', async () => {
  if (process.platform !== 'win32') return { available: false, reason: 'GPU screen recording is currently available on Windows.' }
  const displays = await listNativeDisplays(displayHelper)
  return displays.some(d => d.nvidia && d.defaultAdapter && d.rotation <= 1) ? { available: true } :
    { available: false, reason: 'GPU recording needs the native display helper and a landscape display on the default NVIDIA adapter. Other sources use the browser recorder.' }
})

ipcMain.handle('prepare-native', async (_event, sourceId: string) => {
  claimRecording()
  try {
    const source = (await captureSources()).find(s => s.id === sourceId)
    if (!source?.nativeDisplay) throw new Error('This source does not support GPU screen recording. Select a supported screen or choose Browser in Settings.')
    const settings = loadSettings()
    await watchDisk(settings.outputFolder)
    nativeRecorder = new NativeRecorder(source.nativeDisplay, settings,
      stats => {
        win?.webContents.send('recording-stats', stats)
        overlayWin?.webContents.send('recording-stats', stats)
      }, message => win?.webContents.send('recording-error', message), displayHelper)
    Object.assign(nativeRecorder.info, { sourceId: source.id, sourceName: source.name,
      appVersion: app.getVersion(), qualityPreset: settings.qualityPreset })
    await nativeRecorder.startSegment()
    return { id: nativeRecorder.id, info: nativeRecorder.info }
  } catch (error) {
    await nativeRecorder?.abort()
    releaseRecording()
    throw error
  }
})

function nativeSession(id: string): NativeRecorder {
  if (!nativeRecorder || nativeRecorder.id !== id) throw new Error('The GPU recording session has ended')
  return nativeRecorder
}
function browserSession(id: string): BrowserRecorder {
  if (!browserRecorder || browserRecorder.id !== id) throw new Error('The browser recording session has ended')
  return browserRecorder
}

ipcMain.handle('native-ready', (_event, id: string) => nativeSession(id).waitUntilReady())
ipcMain.handle('native-audio', (_event, id: string, chunk: PCMChunk) => nativeSession(id).writeAudio(chunk))
ipcMain.handle('native-pause', (_event, id: string) => nativeSession(id).pause())
ipcMain.handle('native-resume', async (_event, id: string) => {
  const recorder = nativeSession(id)
  await recorder.startSegment()
})
ipcMain.handle('native-stop', async (_event, id: string) => {
  const recorder = nativeSession(id)
  try {
    const result = await recorder.stop()
    shell.showItemInFolder(result.path)
    return result
  } finally { releaseRecording() }
})

ipcMain.handle('start-save-stream', async (_event, codec: 'h264' | 'vp9', info: CaptureInfo) => {
  claimRecording()
  try {
    if (!['h264', 'vp9'].includes(codec)) throw new Error('Unsupported capture codec')
    const settings = loadSettings()
    if (process.platform === 'win32' && settings.recordingEngine !== 'browser' && info.sourceId?.startsWith('screen:')) {
      throw new Error('Automatic screen recording requires GPU capture. Refresh the sources, or choose Browser explicitly in Settings.')
    }
    await watchDisk(settings.outputFolder)
    browserRecorder = new BrowserRecorder(settings, { ...info, appVersion: app.getVersion(),
      qualityPreset: settings.qualityPreset }, codec)
    await browserRecorder.start()
    return browserRecorder.id
  } catch (error) {
    await browserRecorder?.abort()
    releaseRecording()
    throw error
  }
})
ipcMain.handle('save-chunk', (_event, id: string, chunk: ArrayBuffer) => browserSession(id).write(chunk))
ipcMain.handle('flush-chunks', (_event, id: string) => browserSession(id).flush())
ipcMain.handle('stop-and-save', async (_event, id: string) => {
  const recorder = browserSession(id)
  try {
    const result = await recorder.stop()
    shell.showItemInFolder(result.path)
    return result
  } finally { releaseRecording() }
})
ipcMain.handle('abort-recording', async () => {
  try {
    await nativeRecorder?.abort()
    await browserRecorder?.abort()
  } finally { releaseRecording() }
})

// Export never replaces a master. It is intentionally outside the recording stop path.
ipcMain.handle('export-recording', async (_event, mode: 'copy' | 'small') => {
  if (recordingBusy || exporting || !win) throw new Error('Finish the current recording or export first')
  if (mode !== 'copy' && mode !== 'small') throw new Error('Invalid export mode')
  exporting = true
  try {
    const selected = await dialog.showOpenDialog(win, { title: 'Select a recording to export',
      defaultPath: loadSettings().outputFolder, properties: ['openFile'],
      filters: [{ name: 'Recordings', extensions: ['mkv', 'webm', 'mp4'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const input = selected.filePaths[0]
    const extension = mode === 'small' ? '_smaller.mp4' : '_export.mp4'
    const output = input.replace(/\.[^.]+$/, '') + extension
    await exportRecording(input, output, mode)
    shell.showItemInFolder(output)
    return output
  } finally {
    exporting = false
    if (quitAfterSave) app.quit()
  }
})

// Overlay window controls
ipcMain.on('show-overlay', () => {
  createOverlayWindow()
  win?.minimize()
});

ipcMain.on('hide-overlay', () => {
  closeOverlayWindow()
});

// Timer sync from main window to overlay
ipcMain.on('sync-timer', (_event, data: { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }) => {
  if (overlayWin) {
    overlayWin.webContents.send('timer-update', data)
  }
});

// Control commands from overlay to main window
ipcMain.on('overlay-pause', () => {
  if (win) {
    win.webContents.send('pause-recording')
  }
});

ipcMain.on('overlay-stop', () => {
  if (win) {
    win.webContents.send('stop-recording')
  }
});

ipcMain.on('overlay-mic-toggle', () => {
  if (win) {
    win.webContents.send('mic-toggle')
  }
});

ipcMain.on('minimize-window', () => {
  win?.minimize();
});

ipcMain.on('restore-window', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return loadSettings()
});

ipcMain.handle('save-settings', (_event, settings: Partial<AppSettings>) => {
  return saveSettings(settings)
});

ipcMain.handle('get-quality-presets', () => {
  return qualityPresets
});

ipcMain.handle('select-output-folder', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Output Folder'
  })
  if (!result.canceled && result.filePaths[0]) {
    return result.filePaths[0]
  }
  return null
})
