import { app, BrowserWindow, ipcMain, desktopCapturer, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

// Set ffmpeg path
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
}

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null
let recordingStream: fs.WriteStream | null = null
let tempFilePath: string | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(process.env.VITE_PUBLIC || '', 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // Prevent stopping when minimized
    },
    // Modern sleek look
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#121212',
      symbolColor: '#ffffff',
      height: 30
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(process.env.DIST || '', 'index.html'))
  }
}

app.on('window-all-closed', () => {
  win = null
  app.quit()
})

app.whenReady().then(() => {
  createWindow()
  
  // Create recordings directory
  const recordingsPath = path.join(app.getPath('videos'), 'SleekRecordings');
  if (!fs.existsSync(recordingsPath)) {
    fs.mkdirSync(recordingsPath, { recursive: true });
  }
})


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
  return new Promise((resolve, reject) => {
    if (recordingStream) {
      recordingStream.end();
      recordingStream = null;
    }

    if (!tempFilePath || !fs.existsSync(tempFilePath)) {
      reject('No recording found');
      return;
    }

    const date = new Date();
    const timestamp = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}_${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
    const outputDir = path.join(app.getPath('videos'), 'SleekRecordings');
    const outputPath = path.join(outputDir, `Recording_${timestamp}.mp4`);
    
    ffmpeg(tempFilePath)
      .output(outputPath)
      .videoCodec('libx264')
      .outputOptions([
        '-preset medium',
        '-crf 28',         // Higher CRF = smaller file (23->28 is significant)
        '-pix_fmt yuv420p',
        '-r 30',           // Force 30 fps
        '-g 60',           // Keyframe interval (Group of Pictures)
        '-movflags +faststart' // Web optimization
      ])
      .audioCodec('aac')
      .audioChannels(1)    // Mono audio saves space
      .audioBitrate('96k') // Reduced from 128k
      .on('end', () => {
        // Cleanup temp
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

ipcMain.on('minimize-window', () => {
  win?.minimize();
});

ipcMain.on('restore-window', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});