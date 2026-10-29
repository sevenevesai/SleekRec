import { ipcRenderer, contextBridge } from 'electron'
import type { CaptureInfo, CaptureRegion, ExportRequest, JobProgress, PCMChunk, RecordingStats, SavedRecording } from '../src/recording'

type TimerState = { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }
type NativeOptions = { region?: CaptureRegion; windowArea?: boolean }

function listen<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args as T)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  nativeCapabilities: () => ipcRenderer.invoke('native-capabilities'),
  prepareNative: (sourceId: string, options?: NativeOptions) => ipcRenderer.invoke('prepare-native', sourceId, options),
  nativeReady: (id: string) => ipcRenderer.invoke('native-ready', id),
  nativeAudio: (id: string, chunk: PCMChunk) => ipcRenderer.invoke('native-audio', id, chunk),
  nativePause: (id: string) => ipcRenderer.invoke('native-pause', id),
  nativeResume: (id: string) => ipcRenderer.invoke('native-resume', id),
  nativeStop: (id: string) => ipcRenderer.invoke('native-stop', id),
  replayArm: (sourceId: string, options?: NativeOptions) => ipcRenderer.invoke('replay-arm', sourceId, options),
  replayDisarm: (id: string) => ipcRenderer.invoke('replay-disarm', id),
  replaySave: () => ipcRenderer.invoke('replay-save'),
  pickRegion: (screenSourceId: string) => ipcRenderer.invoke('pick-region', screenSourceId),
  startSave: (codec: 'h264' | 'vp9', info: CaptureInfo) => ipcRenderer.invoke('start-save-stream', codec, info),
  saveChunk: (id: string, chunk: ArrayBuffer) => ipcRenderer.invoke('save-chunk', id, chunk),
  flushChunks: (id: string) => ipcRenderer.invoke('flush-chunks', id),
  stopSave: (id: string) => ipcRenderer.invoke('stop-and-save', id),
  abortRecording: () => ipcRenderer.invoke('abort-recording'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  mediaDetails: (file: string) => ipcRenderer.invoke('media-details', file),
  mediaFrame: (file: string, seconds: number, width: number) => ipcRenderer.invoke('media-frame', file, seconds, width),
  mediaKeyframes: (file: string) => ipcRenderer.invoke('media-keyframes', file),
  recordingAction: (file: string, action: 'open' | 'reveal' | 'copy' | 'trash') => ipcRenderer.invoke('recording-action', file, action),
  startDrag: (file: string) => ipcRenderer.send('start-drag', file),
  recoverRecording: (file: string) => ipcRenderer.invoke('recover-recording', file),
  exportRecording: (file: string | null, request: ExportRequest) => ipcRenderer.invoke('export-recording', file, request),
  trimRecording: (file: string, start: number, end: number, mode: 'fast' | 'exact') =>
    ipcRenderer.invoke('trim-recording', file, start, end, mode),
  cancelJob: () => ipcRenderer.invoke('cancel-job'),
  openOutputFolder: () => ipcRenderer.invoke('open-output-folder'),
  minimize: () => ipcRenderer.send('minimize-window'),
  restore: () => ipcRenderer.send('restore-window'),
  showOverlay: () => ipcRenderer.send('show-overlay'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  toast: (message: string, tone?: 'info' | 'error') => ipcRenderer.send('toast', message, tone),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke('save-settings', settings),
  getQualityPresets: () => ipcRenderer.invoke('get-quality-presets'),
  getHotkeyStatus: () => ipcRenderer.invoke('get-hotkey-status'),
  suspendHotkeys: (suspended: boolean) => ipcRenderer.invoke('suspend-hotkeys', suspended),
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  // Main window -> overlay sync
  syncTimer: (data: TimerState) => ipcRenderer.send('sync-timer', data),
  // Overlay -> main window commands
  overlayPause: () => ipcRenderer.send('overlay-pause'),
  overlayStop: () => ipcRenderer.send('overlay-stop'),
  overlayMicToggle: () => ipcRenderer.send('overlay-mic-toggle'),
  // Region picker
  regionInit: () => ipcRenderer.invoke('region-init'),
  regionDone: (result: { window?: number; rect?: { x: number; y: number; width: number; height: number } } | null) =>
    ipcRenderer.send('region-done', result),
  // Event listeners
  onStopRecording: (callback: () => void) => listen('stop-recording', callback),
  onPauseRecording: (callback: () => void) => listen('pause-recording', callback),
  onMicToggle: (callback: () => void) => listen('mic-toggle', callback),
  onHotkeyRecord: (callback: () => void) => listen('hotkey-record', callback),
  onHotkeyReplayToggle: (callback: () => void) => listen('hotkey-replay-toggle', callback),
  onReplayOff: (callback: () => void) => listen('replay-off', callback),
  onTimerUpdate: (callback: (data: TimerState) => void) => listen('timer-update', callback),
  onRecordingStats: (callback: (stats: RecordingStats) => void) => listen('recording-stats', callback),
  onRecordingError: (callback: (message: string) => void) => listen('recording-error', callback),
  onFinalizeProgress: (callback: (fraction: number) => void) => listen('finalize-progress', callback),
  onReplayStatus: (callback: (seconds: number) => void) => listen('replay-status', callback),
  onReplaySaved: (callback: (saved: SavedRecording) => void) => listen('replay-saved', callback),
  onReplayError: (callback: (message: string) => void) => listen('replay-error', callback),
  onJobProgress: (callback: (progress: JobProgress & { done?: boolean }) => void) => listen('job-progress', callback),
  onLibraryChanged: (callback: () => void) => listen('library-changed', callback),
  onShowView: (callback: (view: 'recordings') => void) => listen('show-view', callback),
  onToast: (callback: (toast: { message: string; tone: 'info' | 'error' }) => void) => listen('toast', callback),
})
