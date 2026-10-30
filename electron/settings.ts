import path from 'node:path'
import { AppSettings, HotkeyAction, Hotkeys, SourceRef, defaultHotkeys, isValidHotkey, replayLengths } from '../src/recording'

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

export function normalizeSettings(input: Partial<AppSettings>, defaults: AppSettings): AppSettings {
  const s = { ...defaults, ...input }
  if (!['low', 'medium', 'high', 'ultra'].includes(s.qualityPreset)) s.qualityPreset = defaults.qualityPreset
  if (!['auto', 'native', 'browser'].includes(s.recordingEngine)) s.recordingEngine = defaults.recordingEngine
  if (!['display', 30, 60, 90, 120, 144, 165, 240].includes(s.frameRate)) s.frameRate = defaults.frameRate
  if (!['h264', 'hevc'].includes(s.nativeCodec)) s.nativeCodec = defaults.nativeCodec
  if (!['mixed', 'separate'].includes(s.micTrack)) s.micTrack = defaults.micTrack
  if (typeof s.outputFolder !== 'string' || !path.isAbsolute(s.outputFolder)) s.outputFolder = defaults.outputFolder
  s.micVolume = Number.isFinite(s.micVolume) ? Math.min(1.5, Math.max(0, s.micVolume)) : defaults.micVolume
  s.micDeviceId = typeof s.micDeviceId === 'string' ? s.micDeviceId : null
  for (const key of ['systemAudio', 'micEnabled', 'micRawInput', 'replayAutoArm', 'startMinimized',
    'closeToTray', 'launchAtLogin'] as const) {
    if (typeof s[key] !== 'boolean') s[key] = defaults[key]
  }
  if (![2, 3, 4].includes(s.columnCount)) s.columnCount = defaults.columnCount
  if (!(replayLengths as readonly number[]).includes(s.replaySeconds)) s.replaySeconds = defaults.replaySeconds
  s.hotkeys = normalizeHotkeys(input.hotkeys)
  s.lastSource = normalizeSource(input.lastSource)
  return s
}
