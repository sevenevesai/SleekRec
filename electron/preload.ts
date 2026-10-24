import { ipcRenderer, contextBridge } from 'electron'
import type { CaptureInfo, PCMChunk, RecordingStats } from '../src/recording'

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  nativeCapabilities: () => ipcRenderer.invoke('native-capabilities'),
  prepareNative: (sourceId: string) => ipcRenderer.invoke('prepare-native', sourceId),
  nativeReady: (id: string) => ipcRenderer.invoke('native-ready', id),
  nativeAudio: (id: string, chunk: PCMChunk) => ipcRenderer.invoke('native-audio', id, chunk),
  nativePause: (id: string) => ipcRenderer.invoke('native-pause', id),
  nativeResume: (id: string) => ipcRenderer.invoke('native-resume', id),
  nativeStop: (id: string) => ipcRenderer.invoke('native-stop', id),
  startSave: (codec: 'h264' | 'vp9', info: CaptureInfo) => ipcRenderer.invoke('start-save-stream', codec, info),
  saveChunk: (id: string, chunk: ArrayBuffer) => ipcRenderer.invoke('save-chunk', id, chunk),
  flushChunks: (id: string) => ipcRenderer.invoke('flush-chunks', id),
  stopSave: (id: string) => ipcRenderer.invoke('stop-and-save', id),
  abortRecording: () => ipcRenderer.invoke('abort-recording'),
  exportRecording: (mode: 'copy' | 'small') => ipcRenderer.invoke('export-recording', mode),
  minimize: () => ipcRenderer.send('minimize-window'),
  restore: () => ipcRenderer.send('restore-window'),
  showOverlay: () => ipcRenderer.send('show-overlay'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke('save-settings', settings),
  getQualityPresets: () => ipcRenderer.invoke('get-quality-presets'),
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  // Main window -> overlay sync
  syncTimer: (data: { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }) => ipcRenderer.send('sync-timer', data),
  // Overlay -> main window commands
  overlayPause: () => ipcRenderer.send('overlay-pause'),
  overlayStop: () => ipcRenderer.send('overlay-stop'),
  overlayMicToggle: () => ipcRenderer.send('overlay-mic-toggle'),
  // Event listeners
  onStopRecording: (callback: () => void) => {
    ipcRenderer.on('stop-recording', callback)
    return () => ipcRenderer.removeListener('stop-recording', callback)
  },
  onPauseRecording: (callback: () => void) => {
    ipcRenderer.on('pause-recording', callback)
    return () => ipcRenderer.removeListener('pause-recording', callback)
  },
  onMicToggle: (callback: () => void) => {
    ipcRenderer.on('mic-toggle', callback)
    return () => ipcRenderer.removeListener('mic-toggle', callback)
  },
  onTimerUpdate: (callback: (data: { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }) => callback(data)
    ipcRenderer.on('timer-update', handler)
    return () => ipcRenderer.removeListener('timer-update', handler)
  },
  onRecordingStats: (callback: (stats: RecordingStats) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, stats: RecordingStats) => callback(stats)
    ipcRenderer.on('recording-stats', handler)
    return () => ipcRenderer.removeListener('recording-stats', handler)
  },
  onRecordingError: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('recording-error', handler)
    return () => ipcRenderer.removeListener('recording-error', handler)
  }
})
