/// <reference types="vite/client" />

type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

interface AppSettings {
  outputFolder: string
  qualityPreset: QualityPreset
  columnCount: number
}

interface QualityPresetConfig {
  crf: number
  preset: string
  videoBitrate: number
  audioBitrate: string
  estimateMbPerMin: number
}

interface Window {
  electronAPI: {
    getSources: () => Promise<{id: string, name: string, thumbnail: string}[]>
    startSave: () => void
    saveChunk: (chunk: ArrayBuffer) => void
    stopSave: () => Promise<string>
    minimize: () => void
    restore: () => void
    showOverlay: () => void
    hideOverlay: () => void
    getSettings: () => Promise<AppSettings>
    saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>
    getQualityPresets: () => Promise<Record<QualityPreset, QualityPresetConfig>>
    selectOutputFolder: () => Promise<string | null>
    syncTimer: (data: { timer: number; isPaused: boolean }) => void
    overlayPause: () => void
    overlayStop: () => void
    onStopRecording: (callback: () => void) => () => void
    onPauseRecording: (callback: () => void) => () => void
    onTimerUpdate: (callback: (data: { timer: number; isPaused: boolean }) => void) => () => void
  }
}
