export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'
export type RecordingEngine = 'auto' | 'native' | 'browser'
export type FrameRate = 'display' | 30 | 60 | 90 | 120 | 144 | 165 | 240
export type NativeCodec = 'h264' | 'hevc'
export type MicTrackMode = 'mixed' | 'separate'
export type HotkeyAction = 'record' | 'stop' | 'pause' | 'replaySave' | 'replayToggle'
/** Electron accelerators; an empty string leaves the action without a hotkey. */
export type Hotkeys = Record<HotkeyAction, string>
export const replayLengths = [30, 60, 120, 300, 600] as const
export type ReplaySeconds = typeof replayLengths[number]
export const fitTargetsMB = [10, 25, 50, 100, 500] as const
export type FitTargetMB = typeof fitTargetsMB[number]
/** Any whole size in this range is a valid fit target; `fitTargetsMB` are the menu's presets. */
export const fitTargetRangeMB = { min: 5, max: 4000 } as const

/** Recordings larger than this many GB stay MKV on stop; 0 always makes the MP4. */
export const mp4LimitsGB = [0, 8, 16, 32, 64] as const
export type Mp4LimitGB = typeof mp4LimitsGB[number]

export type CompressionQuality = 'high' | 'balanced' | 'small'
/** Constant QP per level for hardware encoders; x264 uses CRF one lower. */
export const compressionQp: Record<CompressionQuality, number> = { high: 20, balanced: 24, small: 28 }
export const compressionHeights = ['source', 1440, 1080, 720] as const
export const compressionFpsCaps = ['source', 60, 30] as const

export interface CompressionOptions {
  codec: NativeCodec
  quality: CompressionQuality
  /** Scales down, keeping the aspect ratio, only when the source is taller. */
  maxHeight: typeof compressionHeights[number]
  /** Lowers the frame rate only when the source is faster. */
  maxFps: typeof compressionFpsCaps[number]
}

/** These options reproduce the Compatible H.264 MP4 export. */
export const defaultCompression: CompressionOptions = { codec: 'h264', quality: 'balanced', maxHeight: 'source', maxFps: 'source' }

/** The job queued by itself after a recording saves. Replay saves never queue one. */
export type AfterRecording = 'none' | 'compress' | 'fit'

/** Physical pixels in desktop coordinates, the space DXGI and the native helper report. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

/** What a hotkey or tray start records: the last source started from the picker. */
export interface SourceRef {
  id: string
  name: string
  /** Crop of the screen `id` on the GPU. */
  region?: CaptureRegion
  /** The window `id` recorded as its screen area on the GPU, measured when recording starts. */
  windowArea?: boolean
}

export interface AppSettings {
  outputFolder: string
  qualityPreset: QualityPreset
  recordingEngine: RecordingEngine
  frameRate: FrameRate
  nativeCodec: NativeCodec
  /** Used when the display's adapter offers it for the codec; otherwise the adapter's first family. */
  encoderPreference: 'auto' | EncoderFamily
  mp4MaxGB: Mp4LimitGB
  afterRecording: AfterRecording
  compression: CompressionOptions
  fitTargetMB: number
  /** After a verified automatic copy, move the master to the Recycle Bin. Off unless chosen. */
  recycleMasterAfterCompress: boolean
  systemAudio: boolean
  columnCount: number
  micEnabled: boolean
  micDeviceId: string | null
  micVolume: number
  micRawInput: boolean
  micTrack: MicTrackMode
  hotkeys: Hotkeys
  replaySeconds: ReplaySeconds
  replayAutoArm: boolean
  startMinimized: boolean
  closeToTray: boolean
  launchAtLogin: boolean
  lastSource: SourceRef | null
}

export const defaultHotkeys: Hotkeys = {
  record: 'CommandOrControl+Shift+F8',
  stop: 'CommandOrControl+Shift+F9',
  pause: 'CommandOrControl+Shift+F10',
  replaySave: 'CommandOrControl+Shift+F7',
  replayToggle: '',
}

const hotkeyModifiers = new Set(['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt',
  'Option', 'AltGr', 'Shift', 'Super', 'Meta'])
const namedHotkeys = new Set(['Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete',
  'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
  'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'])

/**
 * Accepts Electron accelerators that make sense as global hotkeys. Letters, digits and
 * punctuation need a modifier, or the hotkey would swallow that key in every other app;
 * function, media and Print Screen keys may stand alone.
 */
export function isValidHotkey(accelerator: string): boolean {
  const parts = accelerator.split('+')
  const key = parts.pop()
  if (!key || parts.some(part => !hotkeyModifiers.has(part)) || new Set(parts).size !== parts.length) return false
  const standalone = /^F([1-9]|1\d|2[0-4])$/.test(key) || /^(Media|Volume)/.test(key) || key === 'PrintScreen'
  const valid = standalone || /^[A-Z0-9]$/.test(key) || /^num[0-9]$/.test(key) || namedHotkeys.has(key) ||
    /^[)!@#$%^&*(:;"'<>?~`{}|\\[\]=,\-./_]$/.test(key)
  return valid && (standalone || parts.length > 0)
}

/** An error's own words, without the prefixes Electron adds on the way across IPC. */
export function errorMessage(error: unknown): string {
  return String(error).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')
}

export const qualityPresets = {
  low: { qp: 28, bitsPerPixel: 0.07, audioBitrate: '96k', audioChannels: 1, audioSampleRate: 44100 },
  medium: { qp: 23, bitsPerPixel: 0.12, audioBitrate: '160k', audioChannels: 2, audioSampleRate: 48000 },
  high: { qp: 19, bitsPerPixel: 0.20, audioBitrate: '256k', audioChannels: 2, audioSampleRate: 48000 },
  ultra: { qp: 0, bitsPerPixel: 0.30, audioBitrate: '320k', audioChannels: 2, audioSampleRate: 48000 },
} as const
export type QualityPresetConfig = typeof qualityPresets[QualityPreset]

/** GPU encoder families in preference order per vendor; Media Foundation is the fallback. */
export type EncoderFamily = 'nvenc' | 'amf' | 'qsv' | 'mf'
export const encoderLabels: Record<EncoderFamily, string> = {
  nvenc: 'NVIDIA NVENC', amf: 'AMD AMF', qsv: 'Intel Quick Sync', mf: 'Media Foundation',
}

export interface NativeDisplay {
  /** DXGI adapter index, as -init_hw_device d3d11va=<index> addresses it. */
  adapter: number
  /** Output index on that adapter, as ddagrab's output_idx addresses it. */
  output: number
  x: number
  y: number
  width: number
  height: number
  refreshRate: number
  rotation: number
  hdr: boolean
  vendorId: number
  deviceId: number
  adapterName: string
  luid: string
  /** Families whose real capture probe succeeded on this adapter, per codec, in `familiesFor` order. */
  encoders?: Partial<Record<NativeCodec, EncoderFamily[]>>
  probeError?: string
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
  encoder?: string
  adapterName?: string
  region?: CaptureRegion
  /** Titles of the audio tracks in file order; the first is the default track. */
  audioTracks?: string[]
  kind?: 'recording' | 'replay'
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
  /** Set when the save kept a fallback, such as an MKV after a failed MP4 conversion. */
  warning?: string
  /** A chosen outcome worth telling the user, such as MKV above the MP4 size limit. Not a fault. */
  note?: string
}

export type LibraryKind = 'recording' | 'replay' | 'trim' | 'export' | 'unfinished'

/** A file (or an unfinished session folder) in the output folder, as the recordings panel lists it. */
export interface LibraryEntry {
  path: string
  name: string
  bytes: number
  modifiedMs: number
  kind: LibraryKind
  container: string
  seconds?: number
  width?: number
  height?: number
  codec?: string
  engine?: 'native' | 'browser'
  /** Delivered average frame rate from the sidecar's packet timestamps. */
  fps?: number
  gapsOver100ms?: number
  audioTracks?: string[]
  derivedFrom?: string
  warning?: string
  /** Unfinished native sessions: the number of Matroska parts on disk. */
  parts?: number
  /** Unfinished folder whose recording was saved but whose parts could not be deleted. */
  savedAs?: string
}

export interface MediaDetails {
  thumbnail?: string
  seconds: number
  width?: number
  height?: number
  codec?: string
  pixelFormat?: string
  audioTracks: string[]
}

export type ExportRequest =
  | { mode: 'copy' }
  | { mode: 'small' }
  | { mode: 'fit'; targetMB: FitTargetMB }

export interface JobProgress {
  id: string
  label: string
  fraction: number
}

export interface PCMChunk {
  /** Interleaved float32 samples; with several tracks, one equal-sized block per track. */
  data: ArrayBuffer
  capturedAt: number
  tracks?: number
}

export interface GpuAdapterStatus {
  name: string
  encoders: Partial<Record<NativeCodec, EncoderFamily[]>>
  error?: string
}

export interface NativeCapabilities {
  available: boolean
  reason?: string
  adapters?: GpuAdapterStatus[]
}

export type GpuSupport = { ok: true; family: EncoderFamily; note?: string } | { ok: false; reason: string }
export type EncoderSettings = Pick<AppSettings, 'nativeCodec' | 'qualityPreset' | 'encoderPreference'>

/**
 * The family a capture uses from an adapter's working families: the preferred one when offered,
 * else the first. Undefined for Ultra without NVENC: never substitute lossy encoding for its
 * lossless 4:4:4 mode, and a preference must not refuse a recording NVENC can make.
 */
export function selectEncoder(families: EncoderFamily[], settings: Pick<AppSettings, 'qualityPreset' | 'encoderPreference'>): EncoderFamily | undefined {
  if (settings.qualityPreset === 'ultra') return families.includes('nvenc') ? 'nvenc' : undefined
  const preferred = settings.encoderPreference
  return preferred !== 'auto' && families.includes(preferred) ? preferred : families[0]
}

/** Whether a screen records on the GPU with these settings, on which encoder, and why not the preferred one. */
export function gpuSupport(display: NativeDisplay, settings: EncoderSettings): GpuSupport {
  if (display.rotation > 1) return { ok: false, reason: 'GPU capture supports landscape displays only. Rotate the display or choose Browser in Settings.' }
  const families = display.encoders?.[settings.nativeCodec] ?? []
  const [codec, other] = settings.nativeCodec === 'hevc' ? ['HEVC', 'h264'] as const : ['H.264', 'hevc'] as const
  if (!families.length) {
    return { ok: false, reason: `No GPU encoder on ${display.adapterName} accepted ${codec} capture.` +
      (display.encoders?.[other]?.length ? ` Choose ${other === 'h264' ? 'H.264' : 'HEVC'} in Settings.`
        : ' Choose Browser in Settings to use the slower recorder.') +
      (display.probeError ? `\n${display.probeError}` : '') }
  }
  const family = selectEncoder(families, settings)
  if (!family) {
    return { ok: false, reason: `Ultra's lossless 4:4:4 needs NVIDIA NVENC; ${display.adapterName} uses ${encoderLabels[families[0]]}. Choose High in Settings.` }
  }
  const preferred = settings.encoderPreference
  if (preferred === 'auto' || preferred === family) return { ok: true, family }
  return { ok: true, family, note: settings.qualityPreset === 'ultra'
    ? `Ultra's lossless 4:4:4 needs ${encoderLabels.nvenc}; using it instead of ${encoderLabels[preferred]}.`
    : `${encoderLabels[preferred]} ${codec} is not available on ${display.adapterName}; using ${encoderLabels[family]}.` }
}

export function captureEngineForSource(source: CaptureSource, setting: RecordingEngine,
  settings?: EncoderSettings): 'native' | 'browser' {
  if (setting === 'browser') return 'browser'
  if (source.nativeDisplay) {
    if (!settings) return 'native'
    const support = gpuSupport(source.nativeDisplay, settings)
    if (support.ok) return 'native'
    throw new Error(support.reason)
  }
  if (setting === 'native') throw new Error('Select a screen marked GPU capture. This source uses the browser recorder.')
  if (source.gpuUnavailableReason) throw new Error(source.gpuUnavailableReason)
  return 'browser'
}

/**
 * The screen a hotkey records before any source was remembered: the one under the cursor, in
 * physical desktop pixels, else the only screen. Undefined when the choice would be a guess.
 */
export function screenAtPoint(sources: CaptureSource[], point?: { x: number; y: number }): CaptureSource | undefined {
  const screens = sources.filter(source => source.id.startsWith('screen:'))
  const under = point && screens.find(({ nativeDisplay: d }) => !!d && point.x >= d.x && point.x < d.x + d.width &&
    point.y >= d.y && point.y < d.y + d.height)
  return under ?? (screens.length === 1 ? screens[0] : undefined)
}

export function requestedFps(setting: FrameRate, refreshRate = 60): number {
  return setting === 'display' ? Math.max(1, Math.min(240, Math.round(refreshRate || 60))) : setting
}

export function captureBitrate(quality: QualityPreset, width: number, height: number, fps: number): number {
  return Math.round(Math.min(250_000_000, Math.max(2_000_000,
    width * height * fps * qualityPresets[quality].bitsPerPixel)))
}

/** Rounds a region to even offsets and dimensions inside the display, as 4:2:0 encoding needs. */
export function clampRegion(region: CaptureRegion, display: Pick<NativeDisplay, 'x' | 'y' | 'width' | 'height'>): CaptureRegion | null {
  const left = Math.max(display.x, Math.round(region.x))
  const top = Math.max(display.y, Math.round(region.y))
  const right = Math.min(display.x + display.width, Math.round(region.x + region.width))
  const bottom = Math.min(display.y + display.height, Math.round(region.y + region.height))
  const x = left + ((left - display.x) % 2)
  const y = top + ((top - display.y) % 2)
  const width = Math.floor((right - x) / 2) * 2
  const height = Math.floor((bottom - y) / 2) * 2
  return width >= 64 && height >= 64 ? { x, y, width, height } : null
}

/** Audio tracks in file order. Mixed comes first so players that play one track hear everything. */
export function audioTrackTitles(settings: Pick<AppSettings, 'systemAudio' | 'micEnabled' | 'micTrack'>): string[] {
  if (settings.systemAudio && settings.micEnabled) {
    return settings.micTrack === 'separate' ? ['Game + microphone', 'Game', 'Microphone'] : ['Game + microphone']
  }
  if (settings.systemAudio) return ['Game']
  if (settings.micEnabled) return ['Microphone']
  return []
}
