import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  startSave: () => ipcRenderer.send('start-save-stream'),
  saveChunk: (chunk: ArrayBuffer) => ipcRenderer.send('save-chunk', chunk),
  stopSave: () => ipcRenderer.invoke('stop-and-save'),
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
  }
})
