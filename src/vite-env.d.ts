/// <reference types="vite/client" />
import type { AppSettings as Settings, CaptureInfo, CaptureRegion, CaptureSource, ExportRequest, HotkeyAction, JobProgress,
  LibraryEntry, MediaDetails, NativeCapabilities, PCMChunk, QualityPreset as Quality, QualityPresetConfig as Preset,
  RecordingStats, SavedRecording } from './recording'

export type TimerState = { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }
export type NativeOptions = { region?: CaptureRegion; windowArea?: boolean }
export type RegionInit = { width: number; height: number; scaleFactor: number;
  windows: { title: string; x: number; y: number; width: number; height: number }[] }
declare global {
  type AppSettings = Settings
  type QualityPreset = Quality
  type QualityPresetConfig = Preset
  interface Window {
    electronAPI: {
      getSources: () => Promise<CaptureSource[]>
      nativeCapabilities: () => Promise<NativeCapabilities>
      prepareNative: (sourceId: string, options?: NativeOptions) => Promise<{ id: string; info: CaptureInfo }>
      nativeReady: (id: string) => Promise<void>
      nativeAudio: (id: string, chunk: PCMChunk) => Promise<void>
      nativePause: (id: string) => Promise<void>
      nativeResume: (id: string) => Promise<void>
      nativeStop: (id: string) => Promise<SavedRecording>
      replayArm: (sourceId: string, options?: NativeOptions) => Promise<{ id: string; info: CaptureInfo }>
      replayDisarm: (id: string) => Promise<void>
      replaySave: () => Promise<SavedRecording>
      pickRegion: (screenSourceId: string) => Promise<CaptureRegion | null>
      startSave: (codec: 'h264' | 'vp9', info: CaptureInfo) => Promise<string>
      saveChunk: (id: string, chunk: ArrayBuffer) => Promise<void>
      flushChunks: (id: string) => Promise<void>
      stopSave: (id: string) => Promise<SavedRecording>
      abortRecording: () => Promise<void>
      listRecordings: () => Promise<LibraryEntry[]>
      mediaDetails: (file: string) => Promise<MediaDetails>
      mediaFrame: (file: string, seconds: number, width: number) => Promise<string>
      mediaKeyframes: (file: string) => Promise<number[]>
      recordingAction: (file: string, action: 'open' | 'reveal' | 'copy' | 'trash') => Promise<void>
      startDrag: (file: string) => void
      recoverRecording: (file: string) => Promise<SavedRecording>
      exportRecording: (file: string | null, request: ExportRequest) => Promise<string | null>
      trimRecording: (file: string, start: number, end: number, mode: 'fast' | 'exact') => Promise<string>
      cancelJob: () => Promise<void>
      openOutputFolder: () => Promise<void>
      minimize: () => void
      restore: () => void
      showOverlay: () => void
      hideOverlay: () => void
      toast: (message: string, tone?: 'info' | 'error') => void
      getSettings: () => Promise<Settings>
      saveSettings: (settings: Partial<Settings>) => Promise<Settings>
      getQualityPresets: () => Promise<Record<Quality, Preset>>
      getHotkeyStatus: () => Promise<Partial<Record<HotkeyAction, 'unavailable'>>>
      suspendHotkeys: (suspended: boolean) => Promise<Partial<Record<HotkeyAction, 'unavailable'>>>
      selectOutputFolder: () => Promise<string | null>
      syncTimer: (data: TimerState) => void
      overlayPause: () => void
      overlayStop: () => void
      overlayMicToggle: () => void
      regionInit: () => Promise<RegionInit | undefined>
      regionDone: (result: { window?: number; rect?: { x: number; y: number; width: number; height: number } } | null) => void
      onStopRecording: (callback: () => void) => () => void
      onPauseRecording: (callback: () => void) => () => void
      onMicToggle: (callback: () => void) => () => void
      onHotkeyRecord: (callback: () => void) => () => void
      onHotkeyReplayToggle: (callback: () => void) => () => void
      onTimerUpdate: (callback: (data: TimerState) => void) => () => void
      onRecordingStats: (callback: (stats: RecordingStats) => void) => () => void
      onRecordingError: (callback: (message: string) => void) => () => void
      onFinalizeProgress: (callback: (fraction: number) => void) => () => void
      onReplayStatus: (callback: (seconds: number) => void) => () => void
      onReplaySaved: (callback: (saved: SavedRecording) => void) => () => void
      onReplayError: (callback: (message: string) => void) => () => void
      onJobProgress: (callback: (progress: JobProgress & { done?: boolean }) => void) => () => void
      onLibraryChanged: (callback: () => void) => () => void
      onShowView: (callback: (view: 'recordings') => void) => () => void
      onToast: (callback: (toast: { message: string; tone: 'info' | 'error' }) => void) => () => void
    }
  }
}
