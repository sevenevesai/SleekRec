import path from 'node:path'
import { AppSettings, CompressionOptions, HotkeyAction, Hotkeys, SourceRef, compressionFpsCaps, compressionHeights,
  defaultHotkeys, fitTargetRangeMB, isValidHotkey, mp4LimitsGB, replayLengths } from '../src/recording'

// Kept free of Electron imports so scripts/test-recording.cjs can check stored-settings handling.

function normalizeHotkeys(input: unknown): Hotkeys {
  const result = { ...defaultHotkeys }
  if (!input || typeof input !== 'object') return result
  const used = new Set<string>()
  for (const action of Object.keys(defaultHotkeys) as HotkeyAction[]) {
    const value = (input as Record<string, unknown>)[action]
    if (value === '') { result[action] = ''; continue }
    if (typeof value === 'string' && isValidHotkey(value)) result[action] = value
    // One accelerator triggers one action; a later duplicate is cleared, not silently shared.
    if (result[action] && used.has(result[action])) result[action] = ''
    if (result[action]) used.add(result[action])
  }
  return result
}

function normalizeSource(input: unknown): SourceRef | null {
  if (!input || typeof input !== 'object') return null
  const { id, name, region, windowArea } = input as Record<string, unknown>
  if (typeof id !== 'string' || !/^(screen|window):/.test(id) || typeof name !== 'string') return null
  const source: SourceRef = { id, name }
  if (region && typeof region === 'object') {
    const { x, y, width, height } = region as Record<string, unknown>
    if ([x, y, width, height].every(Number.isInteger) && Number(width) > 0 && Number(height) > 0) {
      source.region = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
    }
  }
  if (windowArea === true && id.startsWith('window:')) source.windowArea = true
  return source
}

/** Also guards the export IPC, which receives these options from the renderer. */
export function normalizeCompression(input: unknown, fallback: CompressionOptions): CompressionOptions {
  const result = { ...fallback }
  if (!input || typeof input !== 'object') return result
  const { codec, quality, maxHeight, maxFps } = input as Record<string, unknown>
  if (codec === 'h264' || codec === 'hevc') result.codec = codec
  if (quality === 'high' || quality === 'balanced' || quality === 'small') result.quality = quality
  const height = compressionHeights.find(value => value === maxHeight)
  if (height !== undefined) result.maxHeight = height
  const fps = compressionFpsCaps.find(value => value === maxFps)
  if (fps !== undefined) result.maxFps = fps
  return result
}

export function normalizeSettings(input: Partial<AppSettings>, defaults: AppSettings): AppSettings {
  const s = { ...defaults, ...input }
  if (!['low', 'medium', 'high', 'ultra'].includes(s.qualityPreset)) s.qualityPreset = defaults.qualityPreset
  if (!['auto', 'native', 'browser'].includes(s.recordingEngine)) s.recordingEngine = defaults.recordingEngine
  if (!['display', 30, 60, 90, 120, 144, 165, 240].includes(s.frameRate)) s.frameRate = defaults.frameRate
  if (!['h264', 'hevc'].includes(s.nativeCodec)) s.nativeCodec = defaults.nativeCodec
  if (!['auto', 'nvenc', 'amf', 'qsv', 'mf'].includes(s.encoderPreference)) s.encoderPreference = defaults.encoderPreference
  if (!(mp4LimitsGB as readonly number[]).includes(s.mp4MaxGB)) s.mp4MaxGB = defaults.mp4MaxGB
  if (!['none', 'compress', 'fit'].includes(s.afterRecording)) s.afterRecording = defaults.afterRecording
  s.compression = normalizeCompression(input.compression, defaults.compression)
  s.fitTargetMB = Number.isInteger(s.fitTargetMB) && s.fitTargetMB >= fitTargetRangeMB.min && s.fitTargetMB <= fitTargetRangeMB.max
    ? s.fitTargetMB : defaults.fitTargetMB
  if (!['mixed', 'separate'].includes(s.micTrack)) s.micTrack = defaults.micTrack
  if (typeof s.outputFolder !== 'string' || !path.isAbsolute(s.outputFolder)) s.outputFolder = defaults.outputFolder
  s.micVolume = Number.isFinite(s.micVolume) ? Math.min(1.5, Math.max(0, s.micVolume)) : defaults.micVolume
  s.micDeviceId = typeof s.micDeviceId === 'string' ? s.micDeviceId : null
  for (const key of ['systemAudio', 'micEnabled', 'micRawInput', 'replayAutoArm', 'startMinimized',
    'closeToTray', 'launchAtLogin', 'recycleMasterAfterCompress'] as const) {
    if (typeof s[key] !== 'boolean') s[key] = defaults[key]
  }
  if (![2, 3, 4].includes(s.columnCount)) s.columnCount = defaults.columnCount
  if (!(replayLengths as readonly number[]).includes(s.replaySeconds)) s.replaySeconds = defaults.replaySeconds
  s.hotkeys = normalizeHotkeys(input.hotkeys)
  s.lastSource = normalizeSource(input.lastSource)
  return s
}
