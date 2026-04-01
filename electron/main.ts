import { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

// Set ffmpeg path - handle both dev and packaged environments
if (ffmpegPath) {
  // In packaged app, replace app.asar with app.asar.unpacked
  const resolvedPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  ffmpeg.setFfmpegPath(resolvedPath)
}

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null
let overlayWin: BrowserWindow | null = null
let recordingStream: fs.WriteStream | null = null
let tempFilePath: string | null = null

// Settings storage
const settingsPath = path.join(app.getPath('userData'), 'settings.json')

interface AppSettings {
  outputFolder: string
  qualityPreset: 'low' | 'medium' | 'high' | 'ultra'
  columnCount: number
}

const defaultSettings: AppSettings = {
  outputFolder: path.join(app.getPath('videos'), 'SleekRecordings'),
  qualityPreset: 'medium',
  columnCount: 2
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8')
      return { ...defaultSettings, ...JSON.parse(data) }
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return defaultSettings
}

function saveSettings(settings: Partial<AppSettings>) {
  try {
    const current = loadSettings()
    const updated = { ...current, ...settings }
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2))
    return updated
  } catch (e) {
    console.error('Failed to save settings:', e)
    return loadSettings()
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
    width: 280,
    height: 70,
    x: width - 300,
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
    }
  })

  // Make visible on all workspaces/desktops
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setAlwaysOnTop(true, 'floating', 1)

  if (VITE_DEV_SERVER_URL) {
    overlayWin.loadURL(`${VITE_DEV_SERVER_URL}#overlay`)
  } else {
    overlayWin.loadFile(path.join(process.env.DIST || '', 'index.html'), { hash: 'overlay' })
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

  // Create recordings directory from settings
  const settings = loadSettings()
  if (!fs.existsSync(settings.outputFolder)) {
    fs.mkdirSync(settings.outputFolder, { recursive: true });
  }
})


// Quality presets configuration
const qualityPresets = {
  low: { crf: 32, preset: 'faster', videoBitrate: 1500000, audioBitrate: '64k', estimateMbPerMin: 3 },
  medium: { crf: 28, preset: 'medium', videoBitrate: 2500000, audioBitrate: '96k', estimateMbPerMin: 6 },
  high: { crf: 23, preset: 'medium', videoBitrate: 4000000, audioBitrate: '128k', estimateMbPerMin: 12 },
  ultra: { crf: 18, preset: 'slow', videoBitrate: 6000000, audioBitrate: '192k', estimateMbPerMin: 20 }
}

// --- IPC Handlers ---

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: {width: 600, height: 600} })
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL()
  }))
})

ipcMain.on('start-save-stream', () => {
  // Create a temporary file
  const tempDir = app.getPath('temp');
  tempFilePath = path.join(tempDir, `sleek-temp-${Date.now()}.webm`);
  recordingStream = fs.createWriteStream(tempFilePath);
});

ipcMain.on('save-chunk', (_event, chunk) => {
  if (recordingStream) {
    recordingStream.write(Buffer.from(chunk));
  }
});

ipcMain.handle('stop-and-save', async () => {
  closeOverlayWindow()

  return new Promise((resolve, reject) => {
    if (recordingStream) {
      recordingStream.end();
      recordingStream = null;
    }

    if (!tempFilePath || !fs.existsSync(tempFilePath)) {
      reject('No recording found');
      return;
    }

    const settings = loadSettings()
    const preset = qualityPresets[settings.qualityPreset]

    // Ensure output directory exists
    if (!fs.existsSync(settings.outputFolder)) {
      fs.mkdirSync(settings.outputFolder, { recursive: true });
    }

    const date = new Date();
    const timestamp = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}_${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;

    const outputPath = path.join(
      settings.outputFolder,
      `Recording_${timestamp}.mp4`
    );

    ffmpeg(tempFilePath)
      .output(outputPath)
      .videoCodec('libx264')
      .outputOptions([
        `-preset ${preset.preset}`,
        `-crf ${preset.crf}`,
        '-pix_fmt yuv420p',
        '-r 30',
        '-g 60',
        '-movflags +faststart'
      ])
      .audioCodec('aac')
      .audioChannels(1)
      .audioBitrate(preset.audioBitrate)
      .on('end', () => {
        if (tempFilePath) fs.unlinkSync(tempFilePath);
        tempFilePath = null;
        shell.showItemInFolder(outputPath);
        resolve(outputPath);
      })
      .on('error', (err: Error) => {
        console.error('FFmpeg error:', err);
        reject(err.message);
      })
      .run();
  });
});

// Overlay window controls
ipcMain.on('show-overlay', () => {
  createOverlayWindow()
  win?.minimize()
});

ipcMain.on('hide-overlay', () => {
  closeOverlayWindow()
});

// Timer sync from main window to overlay
ipcMain.on('sync-timer', (_event, data: { timer: number; isPaused: boolean }) => {
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
    const newPath = result.filePaths[0]
    saveSettings({ outputFolder: newPath })
    return newPath
  }
  return null
})