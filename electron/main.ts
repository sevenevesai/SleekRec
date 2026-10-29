import { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog, screen, powerSaveBlocker, protocol,
  nativeImage, clipboard, Display, Rectangle } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { AppSettings, CaptureInfo, CaptureRegion, CaptureSource, ExportRequest, HotkeyAction, MediaDetails, NativeCapabilities,
  PCMChunk, SavedRecording, SourceRef, clampRegion, defaultHotkeys, fitTargetsMB, gpuSupport,
  qualityPresets } from '../src/recording'
import { CaptureTarget, NativeRecorder, listNativeDisplays, listWindowRects, locateNativeWindows } from './native-recorder'
import { ReplayBuffer, removeStaleReplayBuffers } from './replay-buffer'
import { withEncoders } from './gpu-capture'
import { BrowserRecorder } from './browser-recorder'
import { JobOptions, exportRecording, fitToSize, grabFrame, keyframeTimes, trimRecording } from './export-recording'
import { CancelledError } from './ffmpeg'
import { probeMedia } from './media-probe'
import { DerivedSidecar, libraryPath, listLibrary, recoverUnfinished, uniqueOutput } from './library'
import { normalizeSettings } from './settings'
import { HotkeyStatus, applyHotkeys, releaseHotkeys } from './hotkeys'
import { AppTray, TrayMode, appIcon } from './tray'
import { updateOnQuit } from './auto-update'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

// Recordings play in the trim editor through this scheme; see registerMediaProtocol.
protocol.registerSchemesAsPrivileged([{ scheme: 'sleekrec-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

let win: BrowserWindow | null
let overlayWin: BrowserWindow | null = null
let toastWin: BrowserWindow | null = null
let frameWin: BrowserWindow | null = null
let tray: AppTray | null = null
let nativeRecorder: NativeRecorder | null = null
let browserRecorder: BrowserRecorder | null = null
let replayBuffer: ReplayBuffer | null = null
let recordingBusy = false
let recordingPaused = false
let job: { id: string; controller: AbortController } | null = null
let sleepBlocker: number | undefined
let quitAfterSave = false
let quitting = false
let stopRecordingDiskWatch: (() => void) | undefined
let stopReplayDiskWatch: (() => void) | undefined
let hotkeyStatus: HotkeyStatus = {}
let toastTimer: ReturnType<typeof setTimeout> | undefined
const displayHelper = app.isPackaged ? path.join(process.resourcesPath, 'windows-displays.exe')
  : path.join(__dirname, '../native/bin/windows-displays.exe')
const preload = path.join(__dirname, 'preload.js')
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function loadPage(window: BrowserWindow, page: string) {
  if (VITE_DEV_SERVER_URL) void window.loadURL(`${VITE_DEV_SERVER_URL}${page}`)
  else void window.loadFile(path.join(process.env.DIST || '', page))
}

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args)
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
  micRawInput: false,
  micTrack: 'mixed',
  hotkeys: { ...defaultHotkeys },
  replaySeconds: 120,
  replayAutoArm: false,
  startMinimized: false,
  closeToTray: false,
  launchAtLogin: false,
  lastSource: null,
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), defaultSettings)
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return normalizeSettings({}, defaultSettings)
}

function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const updated = normalizeSettings({ ...loadSettings(), ...settings }, defaultSettings)
  fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2))
  applySettings(updated)
  return updated
}

/** Side effects of settings outside the renderer: hotkeys, the login item and the tray. */
function applySettings(settings: AppSettings) {
  hotkeyStatus = applyHotkeys(settings.hotkeys, hotkeyHandlers)
  // A development build would register electron.exe itself at login.
  if (app.isPackaged && process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] })
  }
  updateTray(settings)
}

const hotkeyHandlers: Record<HotkeyAction, () => void> = {
  record: () => send('hotkey-record'),
  stop: () => send('stop-recording'),
  pause: () => send('pause-recording'),
  replaySave: () => { void saveReplay().catch(() => {}) }, // saveReplay reports failures in a toast.
  replayToggle: () => send('hotkey-replay-toggle'),
}

function updateTray(settings = loadSettings()) {
  const mode: TrayMode = recordingBusy ? (recordingPaused ? 'paused' : 'recording') : replayBuffer ? 'replay' : 'idle'
  tray?.update({ mode, lastSourceName: settings.lastSource?.name, replayAvailable: process.platform === 'win32',
    labels: { record: settings.hotkeys.record, stop: settings.hotkeys.stop, pause: settings.hotkeys.pause,
      replaySave: settings.hotkeys.replaySave } })
}

function releaseRecording() {
  nativeRecorder = null
  browserRecorder = null
  recordingBusy = false
  recordingPaused = false
  stopRecordingDiskWatch?.()
  stopRecordingDiskWatch = undefined
  closeOverlayWindow()
  closeRegionFrame()
  if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker)
  sleepBlocker = undefined
  updateTray()
  if (quitAfterSave) app.quit()
}

function claimRecording() {
  if (recordingBusy || job) throw new Error('Another recording or export is still active')
  if (replayBuffer) throw new Error('Turn off instant replay before recording')
  recordingBusy = true
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep')
}

const MiB = 1024 * 1024
async function watchDisk(folder: string, onLow: (message: string) => void): Promise<() => void> {
  await fs.promises.mkdir(folder, { recursive: true })
  const freeBytes = async () => {
    const stat = await fs.promises.statfs(folder)
    return stat.bavail * stat.bsize
  }
  if (await freeBytes() < 512 * MiB) throw new Error('Less than 512 MB is free in the recording folder. Free some space before recording.')
  const timer = setInterval(() => {
    void freeBytes().then(bytes => {
      if (bytes >= 512 * MiB) return
      clearInterval(timer)
      onLow('Recording stopped because less than 512 MB of disk space remains.')
    }).catch(error => onLow(`The recording drive is unavailable: ${String(error)}`))
  }, 3000)
  return () => clearInterval(timer)
}

function showMainWindow(view?: 'recordings') {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (view) send('show-view', view)
}

function createWindow(show: boolean) {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    show,
    icon: path.join(process.env.VITE_PUBLIC || '', 'icon.png'),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // Hotkey and tray starts run while the window is hidden.
    },
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 15, y: 15 } } : { titleBarOverlay: { color: '#121212', symbolColor: '#ffffff', height: 30 } }),
  })
  loadPage(win, VITE_DEV_SERVER_URL ? '' : 'index.html')
  win.on('close', event => {
    if (recordingBusy || job) {
      event.preventDefault()
      if (recordingBusy) send('stop-recording')
    } else if (!quitting && loadSettings().closeToTray) {
      event.preventDefault()
      win?.hide()
    }
  })
  win.webContents.on('render-process-gone', () => {
    void Promise.allSettled([nativeRecorder?.abort(), browserRecorder?.abort(), replayBuffer?.stop()]).finally(() => {
      replayBuffer = null
      stopReplayDiskWatch?.()
      releaseRecording()
    })
  })
}

function createOverlayWindow() {
  if (overlayWin) {
    overlayWin.show()
    return
  }
  const { width } = screen.getPrimaryDisplay().workAreaSize
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
    ...(process.platform === 'darwin' && { vibrancy: 'under-window' }),
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setAlwaysOnTop(true, 'floating', 1)
  overlayWin.setContentProtection(true)
  loadPage(overlayWin, 'overlay.html')
  overlayWin.on('closed', () => { overlayWin = null })
}

function closeOverlayWindow() {
  overlayWin?.close()
  overlayWin = null
}

/**
 * Feedback for hotkeys, which mostly fire inside games: an always-on-top note that ignores
 * the mouse and is excluded from capture. Windows suppresses notifications during
 * fullscreen games, so this does not use them.
 */
function toast(message: string, tone: 'info' | 'error' = 'info', ms = 3200) {
  const { x, y, width } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const bounds = { width: 340, height: 64, x: x + width - 360, y: y + (overlayWin ? 100 : 20) }
  if (!toastWin) {
    toastWin = new BrowserWindow({ ...bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focusable: false, show: false, hasShadow: false,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } })
    toastWin.setIgnoreMouseEvents(true)
    toastWin.setAlwaysOnTop(true, 'screen-saver')
    toastWin.setContentProtection(true)
    toastWin.on('closed', () => { toastWin = null })
    loadPage(toastWin, 'toast.html')
  } else toastWin.setBounds(bounds)
  const target = toastWin
  const show = () => { target.webContents.send('toast', { message, tone }); target.showInactive() }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', show)
  else show()
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastWin?.hide(), ms)
}

/** A click-through border just outside a recorded region, excluded from capture. */
function showRegionFrame(target: CaptureTarget) {
  closeRegionFrame()
  if (!target.region || process.platform !== 'win32') return
  const dip = screen.screenToDipRect(null, target.region)
  frameWin = new BrowserWindow({ x: dip.x - 3, y: dip.y - 3, width: dip.width + 6, height: dip.height + 6,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    hasShadow: false, enableLargerThanScreen: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  frameWin.setIgnoreMouseEvents(true)
  frameWin.setAlwaysOnTop(true, 'screen-saver')
  frameWin.setContentProtection(true)
  frameWin.once('ready-to-show', () => frameWin?.showInactive())
  frameWin.on('closed', () => { frameWin = null })
  loadPage(frameWin, 'frame.html')
}

function closeRegionFrame() {
  frameWin?.close()
  frameWin = null
}

function electronDisplayFor(display: { x: number; y: number; width: number; height: number }): Display | undefined {
  return screen.getAllDisplays().find(d => {
    const rect = screen.dipToScreenRect(null, d.bounds)
    return rect.x === display.x && rect.y === display.y && rect.width === display.width && rect.height === display.height
  })
}

/**
 * A full-screen picker over one display: drag a rectangle, or click a window to take its
 * frame. Window rectangles arrive in physical pixels and are shown in the picker's DIPs; a
 * picked window returns its exact physical rectangle, a drawn one converts back.
 */
let picking = false
async function pickRegion(screenSourceId: string): Promise<CaptureRegion | null> {
  if (picking) throw new Error('A region picker is already open')
  picking = true
  try { return await openRegionPicker(screenSourceId) } finally { picking = false }
}

async function openRegionPicker(screenSourceId: string): Promise<CaptureRegion | null> {
  const source = (await captureSources()).find(s => s.id === screenSourceId)
  const native = source?.nativeDisplay
  const display = native && electronDisplayFor(native)
  if (!native || !display) throw new Error('Region capture needs a screen with GPU capture')
  const windows = (await listWindowRects(displayHelper)).flatMap(w => {
    const dip = screen.screenToDipRect(null, w)
    const x = Math.max(dip.x, display.bounds.x)
    const y = Math.max(dip.y, display.bounds.y)
    const right = Math.min(dip.x + dip.width, display.bounds.x + display.bounds.width)
    const bottom = Math.min(dip.y + dip.height, display.bounds.y + display.bounds.height)
    return right - x >= 40 && bottom - y >= 40
      ? [{ title: w.title, physical: w, client: { x: x - display.bounds.x, y: y - display.bounds.y, width: right - x, height: bottom - y } }]
      : []
  })
  const picker = new BrowserWindow({ ...display.bounds, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, enableLargerThanScreen: true, show: false,
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  picker.setAlwaysOnTop(true, 'screen-saver')
  picker.setBounds(display.bounds)
  loadPage(picker, 'region.html')
  return new Promise(resolve => {
    const init = (event: Electron.IpcMainInvokeEvent) => {
      if (event.sender !== picker.webContents) return undefined
      return { width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor,
        windows: windows.map(w => ({ title: w.title, ...w.client })) }
    }
    const done = (event: Electron.IpcMainEvent, result: { window?: number; rect?: Rectangle } | null) => {
      if (event.sender !== picker.webContents) return
      finish(result)
    }
    const finish = (result: { window?: number; rect?: Rectangle } | null) => {
      ipcMain.removeHandler('region-init')
      ipcMain.removeListener('region-done', done)
      if (!picker.isDestroyed()) picker.close()
      if (!result) return resolve(null)
      const chosen = result.window !== undefined ? windows[result.window]?.physical : undefined
      if (chosen) return resolve({ x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height })
      const r = result.rect
      if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return resolve(null)
      resolve(screen.dipToScreenRect(null, { x: display.bounds.x + r.x, y: display.bounds.y + r.y, width: r.width, height: r.height }))
    }
    ipcMain.removeHandler('region-init')
    ipcMain.handle('region-init', init)
    ipcMain.on('region-done', done)
    picker.once('ready-to-show', () => { picker.show(); picker.focus() })
    picker.on('closed', () => finish(null))
  })
}

/** Range requests let <video> seek without reading the whole master. */
function registerMediaProtocol() {
  protocol.handle('sleekrec-media', async request => {
    try {
      const file = libraryPath(loadSettings().outputFolder, decodeURIComponent(new URL(request.url).pathname.slice(1)))
      const { size } = await fs.promises.stat(file)
      const type = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4'
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '')
      if (!range || (!range[1] && !range[2])) {
        return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream,
          { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
      }
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, { status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes' } })
    } catch (error) {
      return new Response(String(error), { status: 404 })
    }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

app.on('window-all-closed', () => {
  win = null
  app.quit()
})

app.on('activate', () => showMainWindow())

app.whenReady().then(() => {
  registerMediaProtocol()
  updateOnQuit().catch(error => console.error('Update failed:', error))
  const settings = loadSettings()
  createWindow(!(settings.startMinimized || process.argv.includes('--hidden')))
  tray = new AppTray({
    record: () => send('hotkey-record'),
    stop: () => send('stop-recording'),
    pause: () => send('pause-recording'),
    replayToggle: () => send('hotkey-replay-toggle'),
    replaySave: () => { void saveReplay().catch(() => {}) }, // saveReplay reports failures in a toast.
    show: () => showMainWindow(),
    showRecordings: () => showMainWindow('recordings'),
    openFolder: () => { void shell.openPath(loadSettings().outputFolder) },
    quit: () => { quitting = true; app.quit() },
  })
  applySettings(settings)
  // Only SleekRec's own replay directory; recordings and capture parts are never removed here.
  void removeStaleReplayBuffers(settings.outputFolder).catch(error => console.error('Replay cleanup failed:', error))
})

app.on('before-quit', event => {
  quitting = true
  if (recordingBusy || job) {
    event.preventDefault()
    quitAfterSave = true
    if (recordingBusy) send('stop-recording')
  } else if (replayBuffer) {
    event.preventDefault()
    void disarmReplay().finally(() => app.quit())
  }
})
app.on('will-quit', () => {
  releaseHotkeys()
  tray?.destroy()
})

async function captureSources(): Promise<CaptureSource[]> {
  const [sources, helperDisplays] = await Promise.all([
    desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 480, height: 270 } }),
    listNativeDisplays(displayHelper)
  ])
  const nativeDisplays = await withEncoders(helperDisplays)
  const displays = screen.getAllDisplays()
  const windows = await locateNativeWindows(displayHelper, sources.map(source => source.id))
  const result: CaptureSource[] = sources.map(source => {
    const display = source.id.startsWith('screen:') ? displays.find(d => String(d.id) === source.display_id) : undefined
    const rect = display && process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : undefined
    const nativeDisplay = rect ? nativeDisplays.find(d => d.x === rect.x && d.y === rect.y &&
      d.width === rect.width && d.height === rect.height) : undefined
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
    const monitor = display && result.find(s => s.nativeDisplay?.luid === display.luid && s.nativeDisplay.output === display.output)
    source.refreshRate = display?.refreshRate
    // This is only a recommendation: choosing a window must never silently
    // widen capture to include everything else visible on the monitor.
    source.recommendedScreenId = monitor?.id
  }
  return result.sort((a, b) => Number(!!b.nativeDisplay) - Number(!!a.nativeDisplay) ||
    Number(b.id.startsWith('screen:')) - Number(a.id.startsWith('screen:')) ||
    (b.refreshRate || 0) - (a.refreshRate || 0))
}

interface NativeOptions {
  region?: CaptureRegion
  windowArea?: boolean
}

function sourceRef(sourceId: unknown, options: unknown): SourceRef {
  if (typeof sourceId !== 'string') throw new Error('Invalid source')
  const { region, windowArea } = (options && typeof options === 'object' ? options : {}) as NativeOptions
  const ref: SourceRef = { id: sourceId, name: '' }
  if (region && [region.x, region.y, region.width, region.height].every(Number.isFinite)) ref.region = region
  if (windowArea === true && sourceId.startsWith('window:')) ref.windowArea = true
  return ref
}

/**
 * The display, encoder family and crop a GPU capture uses. A window area is the window's
 * frame when recording starts, on its monitor; it does not follow the window afterwards.
 */
async function resolveTarget(ref: SourceRef, settings: AppSettings): Promise<{ target: CaptureTarget; source: CaptureSource }> {
  const sources = await captureSources()
  const source = sources.find(s => s.id === ref.id)
  if (!source) throw new Error('This source is no longer available. Refresh the sources.')
  let display = source.nativeDisplay
  let region = ref.region
  if (ref.windowArea) {
    const [location] = await locateNativeWindows(displayHelper, [ref.id])
    if (!location) throw new Error('The window has closed.')
    if (location.minimized) throw new Error('Restore the window before recording its area.')
    display = sources.find(s => s.id === source.recommendedScreenId)?.nativeDisplay
    region = location.window
  }
  if (!display) throw new Error('This source does not support GPU screen recording. Select a supported screen or choose Browser in Settings.')
  const support = gpuSupport(display, settings)
  if (!support.ok) throw new Error(support.reason)
  const crop = region ? clampRegion(region, display) : null
  if (region && !crop) throw new Error('The selected area is outside the screen or smaller than 64 × 64 pixels.')
  const whole = crop && crop.width === display.width && crop.height === display.height
  return { target: { display, family: support.family, ...(crop && !whole ? { region: crop } : {}) }, source }
}

ipcMain.handle('get-sources', captureSources)
ipcMain.handle('native-capabilities', async (): Promise<NativeCapabilities> => {
  if (process.platform !== 'win32') return { available: false, reason: 'GPU screen recording is currently available on Windows.' }
  const displays = await withEncoders(await listNativeDisplays(displayHelper))
  const adapters = [...new Map(displays.map(d => [d.luid, d])).values()].map(d => ({ name: d.adapterName,
    encoders: d.encoders ?? {}, ...(d.probeError ? { error: d.probeError } : {}) }))
  if (!displays.length) return { available: false, reason: 'The native display helper found no displays. Other sources use the browser recorder.', adapters }
  const ready = adapters.filter(a => a.encoders.h264 || a.encoders.hevc)
  return ready.length ? { available: true, adapters } : { available: false, adapters,
    reason: `No GPU encoder initialized on ${adapters.map(a => a.name).join(', ')}. Choose Browser in Settings to record with the slower recorder.` }
})

function describeSource(info: CaptureInfo, source: CaptureSource, settings: AppSettings) {
  Object.assign(info, { sourceId: source.id, sourceName: source.name, appVersion: app.getVersion(), qualityPreset: settings.qualityPreset })
}

ipcMain.handle('prepare-native', async (_event, sourceId: unknown, options: unknown) => {
  claimRecording()
  try {
    const settings = loadSettings()
    const { target, source } = await resolveTarget(sourceRef(sourceId, options), settings)
    stopRecordingDiskWatch = await watchDisk(settings.outputFolder, message => send('recording-error', message))
    nativeRecorder = new NativeRecorder(target, settings,
      stats => {
        send('recording-stats', stats)
        overlayWin?.webContents.send('recording-stats', stats)
      }, message => send('recording-error', message), displayHelper,
      fraction => send('finalize-progress', fraction))
    describeSource(nativeRecorder.info, source, settings)
    await nativeRecorder.startSegment()
    showRegionFrame(target)
    updateTray()
    return { id: nativeRecorder.id, info: nativeRecorder.info }
  } catch (error) {
    await nativeRecorder?.abort()
    releaseRecording()
    throw error
  }
})

function captureSession(id: string): NativeRecorder | ReplayBuffer {
  if (nativeRecorder && nativeRecorder.id === id) return nativeRecorder
  const replay = [replayBuffer, ...stoppingReplays].find(buffer => buffer?.id === id)
  if (replay) return replay
  throw new Error('The GPU recording session has ended')
}
function nativeSession(id: string): NativeRecorder {
  if (!nativeRecorder || nativeRecorder.id !== id) throw new Error('The GPU recording session has ended')
  return nativeRecorder
}
function browserSession(id: string): BrowserRecorder {
  if (!browserRecorder || browserRecorder.id !== id) throw new Error('The browser recording session has ended')
  return browserRecorder
}

ipcMain.handle('native-ready', (_event, id: string) => captureSession(id).waitUntilReady())
ipcMain.handle('native-audio', (_event, id: string, chunk: PCMChunk) => captureSession(id).writeAudio(chunk))
ipcMain.handle('native-pause', (_event, id: string) => nativeSession(id).pause())
ipcMain.handle('native-resume', async (_event, id: string) => {
  const recorder = nativeSession(id)
  await recorder.startSegment()
})
ipcMain.handle('native-stop', async (_event, id: string) => {
  const recorder = nativeSession(id)
  try {
    const result = await recorder.stop()
    send('library-changed')
    return result
  } finally { releaseRecording() }
})

ipcMain.handle('replay-arm', async (_event, sourceId: unknown, options: unknown) => {
  if (replayBuffer) throw new Error('Instant replay is already on')
  if (recordingBusy || job) throw new Error('Finish the current recording or export first')
  const settings = loadSettings()
  const { target, source } = await resolveTarget(sourceRef(sourceId, options), settings)
  const buffer = new ReplayBuffer(target, settings, seconds => send('replay-status', seconds),
    message => send('replay-error', message), displayHelper)
  describeSource(buffer.info, source, settings)
  replayBuffer = buffer
  try {
    stopReplayDiskWatch = await watchDisk(settings.outputFolder, message => {
      send('replay-error', message)
      void disarmReplay()
    })
    await buffer.start()
  } catch (error) {
    await disarmReplay()
    throw error
  }
  updateTray()
  return { id: buffer.id, info: buffer.info }
})

/** Buffers finishing their stop still receive PCM: FFmpeg must handle q before its input closes. */
const stoppingReplays = new Set<ReplayBuffer>()

async function disarmReplay(id?: string): Promise<void> {
  const buffer = replayBuffer
  if (!buffer || (id && buffer.id !== id)) return
  replayBuffer = null
  stopReplayDiskWatch?.()
  stopReplayDiskWatch = undefined
  updateTray()
  stoppingReplays.add(buffer)
  try { await buffer.stop() } finally { stoppingReplays.delete(buffer) }
}
ipcMain.handle('replay-disarm', (_event, id: string) => disarmReplay(id))

const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`

async function saveReplay(): Promise<SavedRecording> {
  const buffer = replayBuffer
  if (!buffer) {
    toast('Instant replay is off. Turn it on in SleekRec or the tray menu.', 'error')
    throw new Error('Instant replay is off')
  }
  toast('Saving replay…', 'info', 15000)
  try {
    const saved = await buffer.save()
    toast(`Replay saved · ${formatClock(saved.stats?.seconds ?? 0)} · ${Math.round((saved.stats?.bytes ?? 0) / 1e6)} MB`)
    send('replay-saved', saved)
    send('library-changed')
    return saved
  } catch (error) {
    toast(`Replay not saved: ${String(error).replace(/^Error: /, '').split('\n')[0]}`, 'error', 6000)
    throw error
  }
}
ipcMain.handle('replay-save', () => saveReplay())

ipcMain.handle('start-save-stream', async (_event, codec: 'h264' | 'vp9', info: CaptureInfo) => {
  claimRecording()
  try {
    if (!['h264', 'vp9'].includes(codec)) throw new Error('Unsupported capture codec')
    const settings = loadSettings()
    if (process.platform === 'win32' && settings.recordingEngine !== 'browser' && info.sourceId?.startsWith('screen:')) {
      throw new Error('Automatic screen recording requires GPU capture. Refresh the sources, or choose Browser explicitly in Settings.')
    }
    stopRecordingDiskWatch = await watchDisk(settings.outputFolder, message => send('recording-error', message))
    browserRecorder = new BrowserRecorder(settings, { ...info, appVersion: app.getVersion(),
      qualityPreset: settings.qualityPreset }, codec)
    await browserRecorder.start()
    updateTray()
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
    send('library-changed')
    return result
  } finally { releaseRecording() }
})
ipcMain.handle('abort-recording', async () => {
  try {
    await nativeRecorder?.abort()
    await browserRecorder?.abort()
  } finally { releaseRecording() }
})

ipcMain.handle('pick-region', (_event, screenSourceId: string) => pickRegion(screenSourceId))

// Recordings panel
const outputFolder = () => loadSettings().outputFolder
const details = new Map<string, Promise<MediaDetails>>()
let detailSlots = 2
const detailQueue: (() => void)[] = []
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (detailSlots === 0) await new Promise<void>(resolve => detailQueue.push(resolve))
  detailSlots--
  try { return await work() } finally {
    detailSlots++
    detailQueue.shift()?.()
  }
}

/** Probe facts and a JPEG thumbnail, cached on disk by path, size and modification time. */
async function mediaDetails(file: string): Promise<MediaDetails> {
  const stat = await fs.promises.stat(file)
  const key = createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}`).digest('hex')
  if (!details.has(key)) {
    const cache = path.join(app.getPath('userData'), 'thumbnails', `${key}.json`)
    details.set(key, limited(async () => {
      try { return JSON.parse(await fs.promises.readFile(cache, 'utf8')) as MediaDetails } catch { /* Not cached yet. */ }
      const info = await probeMedia(file)
      const result: MediaDetails = { seconds: info.seconds, width: info.video?.width, height: info.video?.height,
        codec: info.video?.codec, pixelFormat: info.video?.pixelFormat,
        audioTracks: info.audio.map((stream, i) => stream.title || `Track ${i + 1}`) }
      if (info.video?.width && info.video.height) {
        const width = 320
        const height = Math.max(2, Math.round(width * info.video.height / info.video.width / 2) * 2)
        const at = Math.min(Math.max(0.5, info.seconds * 0.1), Math.max(0, info.seconds - 0.1))
        const frame = await grabFrame(file, at, width, height).catch(() => grabFrame(file, 0, width, height))
        result.thumbnail = 'data:image/jpeg;base64,' + nativeImage.createFromBitmap(frame, { width, height }).toJPEG(78).toString('base64')
      }
      await fs.promises.mkdir(path.dirname(cache), { recursive: true })
      await fs.promises.writeFile(cache, JSON.stringify(result)).catch(() => {}) // The cache is an optimization.
      return result
    }))
    void details.get(key)!.catch(() => details.delete(key))
  }
  return details.get(key)!
}

ipcMain.handle('list-recordings', () => listLibrary(outputFolder()))
ipcMain.handle('media-details', (_event, file: unknown) => mediaDetails(libraryPath(outputFolder(), file)))
ipcMain.handle('media-frame', async (_event, file: unknown, seconds: number, width: number) => {
  const input = libraryPath(outputFolder(), file)
  const info = await mediaDetails(input)
  const w = Math.max(2, Math.min(1280, Math.round(width / 2) * 2))
  const h = Math.max(2, Math.round(w * (info.height || 9) / (info.width || 16) / 2) * 2)
  const frame = await grabFrame(input, Number(seconds) || 0, w, h, false)
  return 'data:image/jpeg;base64,' + nativeImage.createFromBitmap(frame, { width: w, height: h }).toJPEG(80).toString('base64')
})
ipcMain.handle('media-keyframes', (_event, file: unknown) => keyframeTimes(libraryPath(outputFolder(), file)))

function copyFiles(files: string[]): Promise<void> {
  if (process.platform !== 'win32') { clipboard.writeText(files.join('\n')); return Promise.resolve() }
  return new Promise((resolve, reject) => execFile(displayHelper, ['--copy-files', ...files], { windowsHide: true, timeout: 5000 },
    error => error ? reject(new Error(`Could not copy the file to the clipboard (${error.message})`)) : resolve()))
}

ipcMain.handle('recording-action', async (_event, file: unknown, action: string) => {
  const target = libraryPath(outputFolder(), file, { folder: action === 'trash' })
  if (action === 'open') {
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  } else if (action === 'reveal') shell.showItemInFolder(target)
  else if (action === 'copy') await copyFiles([target])
  else if (action === 'trash') {
    await shell.trashItem(target)
    if (fs.existsSync(`${target}.json`)) await shell.trashItem(`${target}.json`)
    send('library-changed')
  } else throw new Error('Unknown action')
})

ipcMain.on('start-drag', (event, file: unknown) => {
  try {
    event.sender.startDrag({ file: libraryPath(outputFolder(), file), icon: appIcon() })
  } catch (error) {
    send('recording-error', String(error))
  }
})

ipcMain.handle('open-output-folder', async () => {
  const error = await shell.openPath(outputFolder())
  if (error) throw new Error(error)
})

/** One export, trim or recovery at a time, never during a recording; replay may stay armed. */
async function runJob<T>(label: string, work: (options: JobOptions) => Promise<T>): Promise<T> {
  if (recordingBusy || job) throw new Error('Finish the current recording or export first')
  const id = randomUUID()
  job = { id, controller: new AbortController() }
  const progress = (fraction: number) => send('job-progress', { id, label, fraction })
  progress(0)
  try {
    return await work({ signal: job.controller.signal, onProgress: progress })
  } catch (error) {
    if (error instanceof CancelledError) throw new Error(`${label.replace(/…$/, '')} cancelled`)
    throw error
  } finally {
    job = null
    send('job-progress', { id, label, fraction: 1, done: true })
    send('library-changed')
    if (quitAfterSave) app.quit()
  }
}
ipcMain.handle('cancel-job', () => { job?.controller.abort() })

async function writeDerivedSidecar(output: string, sidecar: Omit<DerivedSidecar, 'path' | 'seconds' | 'width' | 'height'>) {
  const info = await probeMedia(output).catch(() => undefined)
  const data: DerivedSidecar = { path: output, ...sidecar, seconds: info?.seconds, width: info?.video?.width, height: info?.video?.height }
  await fs.promises.writeFile(`${output}.json`, JSON.stringify(data, null, 2)).catch(() => {}) // Only panel details depend on it.
}

ipcMain.handle('export-recording', async (_event, file: unknown, request: ExportRequest) => {
  if (!win) throw new Error('The window is closed')
  let input: string
  if (file === null) {
    const selected = await dialog.showOpenDialog(win, { title: 'Select a recording to export',
      defaultPath: outputFolder(), properties: ['openFile'], filters: [{ name: 'Recordings', extensions: ['mkv', 'webm', 'mp4'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    input = selected.filePaths[0]
  } else input = libraryPath(outputFolder(), file)
  if (request?.mode === 'fit') {
    if (!fitTargetsMB.includes(request.targetMB)) throw new Error('Invalid size')
    const output = await uniqueOutput(input, `_fit-${request.targetMB}MB`, '.mp4')
    const result = await runJob(`Fitting under ${request.targetMB} MB…`,
      options => fitToSize(input, output, request.targetMB * 1_000_000, options))
    await writeDerivedSidecar(output, { derivedFrom: input, operation: 'export',
      detail: `Fits ${request.targetMB} MB · ${result.fps} fps · ${result.encoder === 'x264' ? 'x264 two-pass' : result.encoder.toUpperCase()}` })
    return output
  }
  if (request?.mode !== 'copy' && request?.mode !== 'small') throw new Error('Invalid export mode')
  const output = await uniqueOutput(input, request.mode === 'copy' ? '_export' : '_compatible', '.mp4')
  await runJob(request.mode === 'copy' ? 'Exporting MP4…' : 'Making a compatible MP4…',
    options => exportRecording(input, output, request.mode as 'copy' | 'small', options))
  await writeDerivedSidecar(output, { derivedFrom: input, operation: 'export',
    detail: request.mode === 'copy' ? 'MP4 · same video' : 'Compatible H.264 MP4' })
  return output
})

ipcMain.handle('trim-recording', async (_event, file: unknown, start: number, end: number, mode: 'fast' | 'exact') => {
  const input = libraryPath(outputFolder(), file)
  if (mode !== 'fast' && mode !== 'exact') throw new Error('Invalid trim mode')
  const output = await uniqueOutput(input, '_trim', mode === 'exact' ? '.mp4' : path.extname(input))
  const range = await runJob('Trimming…', options => trimRecording(input, output, Number(start), Number(end), mode, options))
  await writeDerivedSidecar(output, { derivedFrom: input, operation: 'trim',
    detail: `${formatClock(range.start)}–${formatClock(range.end)} · ${mode === 'fast' ? 'original quality' : 're-encoded, exact'}` })
  return output
})

ipcMain.handle('recover-recording', async (_event, file: unknown) => {
  const input = libraryPath(outputFolder(), file, { folder: true })
  const result = await runJob('Recovering…', () => recoverUnfinished(input))
  const info = await probeMedia(result.path)
  Object.assign(result.info, { width: info.video?.width ?? 0, height: info.video?.height ?? 0, codec: info.video?.codec ?? 'unknown' })
  result.stats = { frames: 0, fps: info.video?.fps ?? 0, seconds: info.seconds, bytes: fs.statSync(result.path).size, speed: 1 }
  await fs.promises.writeFile(`${result.path}.json`, JSON.stringify(result, null, 2)).catch(() => {}) // Panel details only.
  // The originals stay recoverable from the recycle bin.
  await shell.trashItem(input)
  send('library-changed')
  return result
})

// Overlay window controls
ipcMain.on('show-overlay', () => {
  createOverlayWindow()
  if (win?.isVisible() && !win.isMinimized()) win.minimize()
})
ipcMain.on('hide-overlay', () => closeOverlayWindow())
ipcMain.on('sync-timer', (_event, data: { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }) => {
  overlayWin?.webContents.send('timer-update', data)
  if (recordingBusy && data.isPaused !== recordingPaused) {
    recordingPaused = data.isPaused
    updateTray()
  }
})
ipcMain.on('overlay-pause', () => send('pause-recording'))
ipcMain.on('overlay-stop', () => send('stop-recording'))
ipcMain.on('overlay-mic-toggle', () => send('mic-toggle'))
ipcMain.on('minimize-window', () => win?.minimize())
ipcMain.on('restore-window', () => showMainWindow())
ipcMain.on('toast', (_event, message: unknown, tone: unknown) => {
  if (typeof message === 'string') toast(message.slice(0, 200), tone === 'error' ? 'error' : 'info')
})

// Settings handlers
ipcMain.handle('get-settings', () => loadSettings())
ipcMain.handle('save-settings', (_event, settings: Partial<AppSettings>) => saveSettings(settings))
ipcMain.handle('get-quality-presets', () => qualityPresets)
ipcMain.handle('get-hotkey-status', () => hotkeyStatus)
ipcMain.handle('suspend-hotkeys', (_event, suspended: boolean) => {
  if (suspended) releaseHotkeys()
  else hotkeyStatus = applyHotkeys(loadSettings().hotkeys, hotkeyHandlers)
  return hotkeyStatus
})
ipcMain.handle('select-output-folder', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    defaultPath: loadSettings().outputFolder,
    properties: ['openDirectory'],
    title: 'Select Output Folder'
  })
  return !result.canceled && result.filePaths[0] ? result.filePaths[0] : null
})
