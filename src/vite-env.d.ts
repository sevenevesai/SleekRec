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

// Demo Mode Types
interface InteractionEvent {
  type: 'click' | 'focus' | 'idle-start' | 'idle-end'
  timestamp: number      // ms from recording start
  x: number              // screen coordinates (normalized 0-1)
  y: number
  button?: 'left' | 'right' | 'middle'
  meta?: {
    zoomLevel?: number   // override default zoom (1.0 = 100%)
    duration?: number    // override hold duration
    skip?: boolean       // marked for exclusion in editor
  }
}

interface CursorFrame {
  timestamp: number
  x: number              // normalized 0-1
  y: number
  visible: boolean
  clicking: boolean
}

interface DemoModeSettings {
  clickZoom: {
    enabled: boolean
    level: number          // default 1.5 = 150%
    easeIn: number         // ms, default 250
    easeOut: number        // ms, default 300
    holdDuration: number   // ms, default 400
  }
  cursor: {
    hide: boolean          // hide system cursor
    overlay: 'none' | 'dot' | 'pointer' | 'custom'
    smoothing: number      // 0-1, bezier tension
    clickEffect: 'none' | 'ripple' | 'pulse' | 'highlight'
    clickEffectSize: number
    clickEffectColor: string
  }
  transitions: {
    idleThreshold: number  // ms before marking idle (default 1500)
    idleSpeedup: number    // playback speed during idle (default 3)
    fadeOnJump: boolean    // fade when cursor teleports
  }
}

interface RecordingSession {
  video: string                    // path to raw WebM
  events: InteractionEvent[]
  cursorFrames: CursorFrame[]      // sampled at 60fps
  duration: number
  resolution: { width: number; height: number }
  settings: DemoModeSettings
  createdAt: string
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
    // Demo Mode APIs
    startDemoRecording: (resolution: { width: number; height: number }) => void
    recordEvent: (event: InteractionEvent) => void
    recordCursorFrame: (frame: CursorFrame) => void
    stopDemoRecording: () => Promise<string>  // returns session.json path
    getDemoSettings: () => Promise<DemoModeSettings>
    saveDemoSettings: (settings: Partial<DemoModeSettings>) => Promise<DemoModeSettings>
  }
}
