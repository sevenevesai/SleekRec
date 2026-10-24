export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'
export type RecordingEngine = 'auto' | 'native' | 'browser'
export type FrameRate = 'display' | 30 | 60 | 90 | 120 | 144 | 165 | 240
export type NativeCodec = 'h264' | 'hevc'

export interface AppSettings {
  outputFolder: string
  qualityPreset: QualityPreset
  recordingEngine: RecordingEngine
  frameRate: FrameRate
  nativeCodec: NativeCodec
  systemAudio: boolean
  columnCount: number
  micEnabled: boolean
  micDeviceId: string | null
  micVolume: number
  micRawInput: boolean
}

export const qualityPresets = {
  low: { qp: 28, bitsPerPixel: 0.07, audioBitrate: '96k', audioChannels: 1, audioSampleRate: 44100 },
  medium: { qp: 23, bitsPerPixel: 0.12, audioBitrate: '160k', audioChannels: 2, audioSampleRate: 48000 },
  high: { qp: 19, bitsPerPixel: 0.20, audioBitrate: '256k', audioChannels: 2, audioSampleRate: 48000 },
  ultra: { qp: 0, bitsPerPixel: 0.30, audioBitrate: '320k', audioChannels: 2, audioSampleRate: 48000 },
} as const
export type QualityPresetConfig = typeof qualityPresets[QualityPreset]

export interface NativeDisplay {
  adapter: number
  output: number
  x: number
  y: number
  width: number
  height: number
  refreshRate: number
  rotation: number
  nvidia: boolean
  defaultAdapter: boolean
}

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  width?: number
  height?: number
  refreshRate?: number
  nativeDisplay?: NativeDisplay
  recommendedScreenId?: string
  gpuUnavailableReason?: string
}

export interface CaptureInfo {
  engine: 'native' | 'browser'
  codec: string
  width: number
  height: number
  targetFps: number
  captureFps?: number
  bitrate?: number
  quality?: 'lossless-444' | 'lossy-420'
  sourceId?: string
  sourceName?: string
  appVersion?: string
  qualityPreset?: QualityPreset
}

export interface FramePacing {
  frames: number
  averageFps: number
  p95GapMs: number
  maxGapMs: number
  gapsOver50ms: number
  gapsOver100ms: number
  nonMonotonicTimestamps: number
}

export interface RecordingStats {
  frames: number
  fps: number
  seconds: number
  bytes: number
  speed: number
  warning?: string
  pacing?: FramePacing
}

export interface SavedRecording {
  path: string
  info: CaptureInfo
  stats?: RecordingStats
}

export interface PCMChunk {
  data: ArrayBuffer
  capturedAt: number
}

export interface NativeCapabilities {
  available: boolean
  reason?: string
}

export function captureEngineForSource(source: CaptureSource, setting: RecordingEngine): 'native' | 'browser' {
  if (setting === 'browser') return 'browser'
  if (source.nativeDisplay) return 'native'
  if (setting === 'native') throw new Error('Select a screen marked GPU capture. This source uses the browser recorder.')
  if (source.gpuUnavailableReason) throw new Error(source.gpuUnavailableReason)
  return 'browser'
}

export function requestedFps(setting: FrameRate, refreshRate = 60): number {
  return setting === 'display' ? Math.max(1, Math.min(240, Math.round(refreshRate || 60))) : setting
}

export function captureBitrate(quality: QualityPreset, width: number, height: number, fps: number): number {
  return Math.round(Math.min(250_000_000, Math.max(2_000_000,
    width * height * fps * qualityPresets[quality].bitsPerPixel)))
}
