/// <reference types="vite/client" />
import type { AppSettings as Settings, CaptureInfo, CaptureSource, NativeCapabilities, PCMChunk, QualityPreset as Quality,
  QualityPresetConfig as Preset, RecordingStats, SavedRecording } from './recording'

export type TimerState = { timer: number; isPaused: boolean; isMicMuted: boolean; hasMic: boolean }
declare global {
  type AppSettings = Settings
  type QualityPreset = Quality
  type QualityPresetConfig = Preset
  interface Window {
    electronAPI: {
      getSources: () => Promise<CaptureSource[]>
      nativeCapabilities: () => Promise<NativeCapabilities>
      prepareNative: (sourceId: string) => Promise<{ id: string; info: CaptureInfo }>
      nativeReady: (id: string) => Promise<void>
      nativeAudio: (id: string, chunk: PCMChunk) => Promise<void>
      nativePause: (id: string) => Promise<void>
      nativeResume: (id: string) => Promise<void>
      nativeStop: (id: string) => Promise<SavedRecording>
      startSave: (codec: 'h264' | 'vp9', info: CaptureInfo) => Promise<string>
      saveChunk: (id: string, chunk: ArrayBuffer) => Promise<void>
      flushChunks: (id: string) => Promise<void>
      stopSave: (id: string) => Promise<SavedRecording>
      abortRecording: () => Promise<void>
      exportRecording: (mode: 'copy' | 'small') => Promise<string | null>
      minimize: () => void
      restore: () => void
      showOverlay: () => void
      hideOverlay: () => void
      getSettings: () => Promise<Settings>
      saveSettings: (settings: Partial<Settings>) => Promise<Settings>
      getQualityPresets: () => Promise<Record<Quality, Preset>>
      selectOutputFolder: () => Promise<string | null>
      syncTimer: (data: TimerState) => void
      overlayPause: () => void
      overlayStop: () => void
      overlayMicToggle: () => void
      onStopRecording: (callback: () => void) => () => void
      onPauseRecording: (callback: () => void) => () => void
      onMicToggle: (callback: () => void) => () => void
      onTimerUpdate: (callback: (data: TimerState) => void) => () => void
      onRecordingStats: (callback: (stats: RecordingStats) => void) => () => void
      onRecordingError: (callback: (message: string) => void) => () => void
    }
  }
}
