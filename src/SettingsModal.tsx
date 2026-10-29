import { useEffect, useRef, useState } from 'react'
import { FrameRate, HotkeyAction, NativeCapabilities, ReplaySeconds, encoderLabels, replayLengths } from './recording'

export const hotkeyNames: Record<HotkeyAction, string> = {
  record: 'Start or stop recording', stop: 'Stop and save', pause: 'Pause or resume',
  replaySave: 'Save instant replay', replayToggle: 'Turn instant replay on or off',
}

export function hotkeyLabel(accelerator: string): string {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/g, navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl')
}

export function formatSeconds(seconds: number): string {
  const s = Math.round(seconds)
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const keyNames: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', Escape: 'Esc', '+': 'Plus' }

/** A key event as an Electron accelerator, or null while only modifiers are held. */
function accelerator(event: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5)
    : /^Numpad\d$/.test(event.code) ? `num${event.code.slice(6)}` : keyNames[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  const parts = [event.ctrlKey && 'CommandOrControl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super']
    .filter((part): part is string => !!part)
  return [...parts, key].join('+')
}

function HotkeyInput({ value, onChange, unavailable }: { value: string; onChange: (value: string) => void; unavailable: boolean }) {
  const [listening, setListening] = useState(false)
  const stopListening = () => {
    setListening(false)
    void window.electronAPI.suspendHotkeys(false)
  }
  return <div className="flex items-center gap-2">
    <button type="button"
      onClick={() => { setListening(true); void window.electronAPI.suspendHotkeys(true) }}
      onBlur={() => { if (listening) stopListening() }}
      onKeyDown={event => {
        if (!listening) return
        event.preventDefault()
        if (event.key === 'Escape') { stopListening(); return }
        if (event.key === 'Backspace' || event.key === 'Delete') { onChange(''); stopListening(); return }
        const combo = accelerator(event)
        if (combo) { onChange(combo); stopListening() }
      }}
      className={`min-w-44 rounded-lg px-3 py-1.5 text-sm text-left tabular-nums border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        listening ? 'border-primary bg-primary/10 text-primary' : unavailable ? 'border-red-500/50 bg-gray-800 text-red-200' : 'border-gray-700 bg-gray-800 text-gray-200'}`}>
      {listening ? 'Press keys…' : value ? hotkeyLabel(value) : 'Not set'}
    </button>
    {value && !listening && <button type="button" onClick={() => onChange('')}
      className="text-xs text-gray-500 hover:text-gray-200 px-1" aria-label="Clear hotkey">Clear</button>}
    {unavailable && !listening && <span className="text-xs text-red-300">In use by another app</span>}
  </div>
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: (checked: boolean) => void; label: string; detail?: string }) {
  return <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
    <input type="checkbox" className="mt-1 accent-primary" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span>{label}{detail && <span className="block text-xs text-gray-500">{detail}</span>}</span>
  </label>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3 pt-5 first:pt-0">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
    {children}
  </section>
}

const selectStyle = 'w-full bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 border border-gray-700 focus:border-primary focus:outline-none'

export function SettingsModal({ isOpen, onClose, settings, onSave }: {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings
  onSave: (settings: Partial<AppSettings>) => void
}) {
  const [local, setLocal] = useState(settings)
  const [presets, setPresets] = useState<Record<QualityPreset, QualityPresetConfig> | null>(null)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [micLevel, setMicLevel] = useState(0)
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null)
  const [hotkeyStatus, setHotkeyStatus] = useState<Partial<Record<HotkeyAction, 'unavailable'>>>({})
  const micMeterRef = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null)
  const micMeterGenerationRef = useRef(0)
  const set = (changes: Partial<AppSettings>) => setLocal(prev => ({ ...prev, ...changes }))

  useEffect(() => { setLocal(settings) }, [settings])

  useEffect(() => {
    if (!isOpen) return
    window.electronAPI.getQualityPresets().then(setPresets).catch(() => {})
    window.electronAPI.nativeCapabilities().then(setCapabilities).catch(() => {})
    window.electronAPI.getHotkeyStatus().then(setHotkeyStatus).catch(() => {})
    void refreshMicDevices()
    const handleDeviceChange = () => { void refreshMicDevices() }
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    // A listening hotkey field consumes Escape (preventDefault) to cancel itself, not the dialog.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      window.removeEventListener('keydown', onKey)
      stopMicMeter()
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && local.micEnabled) void startMicMeter()
    else stopMicMeter()
    return () => { stopMicMeter() }
  }, [isOpen, local.micEnabled, local.micDeviceId])

  // The settings meter owns its own stream, separate from the recording graph.
  const startMicMeter = async () => {
    stopMicMeter()
    const generation = micMeterGenerationRef.current
    try {
      const constraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      if (local.micDeviceId) constraints.deviceId = { exact: local.micDeviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      if (generation !== micMeterGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (generation !== micMeterGenerationRef.current || !micMeterRef.current) return
        analyser.getByteFrequencyData(data)
        setMicLevel(data.reduce((sum, value) => sum + value, 0) / data.length / 255)
        micMeterRef.current.raf = requestAnimationFrame(tick)
      }
      micMeterRef.current = { stream, ctx, raf: requestAnimationFrame(tick) }
      void refreshMicDevices()
    } catch {
      setMicLevel(0)
    }
  }

  const stopMicMeter = () => {
    micMeterGenerationRef.current++
    if (micMeterRef.current) {
      cancelAnimationFrame(micMeterRef.current.raf)
      micMeterRef.current.stream.getTracks().forEach(t => t.stop())
      void micMeterRef.current.ctx.close()
      micMeterRef.current = null
    }
    setMicLevel(0)
  }

  const refreshMicDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMicDevices(devices.filter(d => d.kind === 'audioinput'))
    } catch {
      setMicDevices([])
    }
  }

  if (!isOpen) return null

  const qualityOptions: { value: QualityPreset; label: string; desc: string }[] = [
    { value: 'low', label: 'Low', desc: 'Smallest files, good for quick shares' },
    { value: 'medium', label: 'Medium', desc: 'Balanced quality and size' },
    { value: 'high', label: 'High', desc: 'High quality, larger files' },
    { value: 'ultra', label: 'Ultra', desc: 'Lossless 4:4:4 master on NVIDIA; very large MKV files' },
  ]
  const currentPreset = presets?.[local.qualityPreset]
  const adapters = capabilities?.adapters ?? []

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div role="dialog" aria-label="Settings"
        className="bg-surface border border-gray-700 rounded-xl w-full max-w-xl shadow-2xl max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white px-6 pt-5 pb-3">Settings</h2>
        <div className="overflow-y-auto overscroll-contain px-6 pb-4 divide-y divide-gray-800 [&>section]:pb-5">
          <Section title="Video">
            <div className="grid grid-cols-4 gap-2">
              {qualityOptions.map(opt => (
                <button key={opt.value} onClick={() => set({ qualityPreset: opt.value })}
                  className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${local.qualityPreset === opt.value
                    ? 'bg-primary text-black' : 'bg-gray-700/50 text-gray-300 hover:bg-gray-600/50'}`}>{opt.label}</button>
              ))}
            </div>
            {currentPreset && <p className="text-xs text-gray-500">
              {qualityOptions.find(option => option.value === local.qualityPreset)?.desc}.
              {local.qualityPreset === 'ultra'
                ? ' NVENC keeps every YUV sample after color conversion; AMD, Intel and window recording cannot. Ultra stays MKV, since 4:4:4 in MP4 plays no better.'
                : ` GPU recording uses constant QP ${currentPreset.qp}; file size varies with motion and detail.`}
            </p>}
            <label className="block text-sm text-gray-400">Recorder</label>
            <select aria-label="Recorder" value={local.recordingEngine} className={selectStyle}
              onChange={e => set({ recordingEngine: e.target.value as AppSettings['recordingEngine'] })}>
              <option value="auto">Automatic — GPU for supported screens</option>
              <option value="native">GPU screen recording only (Windows)</option>
              <option value="browser">Browser — windows and other platforms</option>
            </select>
            {adapters.map(adapter => <p key={adapter.name} className="text-xs text-gray-400">
              {adapter.name}: {adapter.encoders.h264 || adapter.encoders.hevc
                ? `H.264 ${adapter.encoders.h264 ? `via ${encoderLabels[adapter.encoders.h264]}` : 'unavailable'} · HEVC ${adapter.encoders.hevc ? `via ${encoderLabels[adapter.encoders.hevc]}` : 'unavailable'}`
                : 'no GPU encoder initialized'}
            </p>)}
            {capabilities?.reason && <p className="text-xs text-yellow-300">{capabilities.reason}</p>}
            <label className="block text-sm text-gray-400">Frame rate at source resolution</label>
            <select aria-label="Frame rate" value={local.frameRate} className={selectStyle}
              onChange={e => set({ frameRate: e.target.value === 'display' ? 'display' : Number(e.target.value) as FrameRate })}>
              <option value="display">Match display refresh (up to 240 fps)</option>
              {[30, 60, 90, 120, 144, 165, 240].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}
            </select>
            <label className="block text-sm text-gray-400">GPU codec</label>
            <select aria-label="GPU codec" value={local.nativeCodec} className={selectStyle}
              onChange={e => set({ nativeCodec: e.target.value as AppSettings['nativeCodec'] })}>
              <option value="h264">H.264 — plays everywhere</option>
              <option value="hevc">HEVC — smaller files, newer players</option>
            </select>
            <p className="text-xs text-gray-500">GPU recordings capture into a crash-safe MKV and become an MP4 when you stop. Full-screen games: select the screen; delivered frame rate depends on GPU headroom, so watch the live rate during motion.</p>
          </Section>

          <Section title="Audio">
            <Toggle checked={local.systemAudio} onChange={systemAudio => set({ systemAudio })} label="System and game audio" />
            <Toggle checked={local.micEnabled} onChange={micEnabled => set({ micEnabled })} label="Microphone" />
            {local.micEnabled && <div className="space-y-3 pl-7">
              <select aria-label="Microphone device" value={local.micDeviceId ?? ''} className={selectStyle}
                onChange={e => set({ micDeviceId: e.target.value || null })}>
                <option value="">Default microphone</option>
                {micDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
              <div>
                <span className="block text-xs text-gray-500 mb-1">Input level</span>
                <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full origin-left transition-transform duration-75"
                    style={{ transform: `scaleX(${Math.min(micLevel, 1)})`, backgroundColor: micLevel > 0.8 ? '#ef4444' : micLevel > 0.5 ? '#eab308' : '#22c55e' }} />
                </div>
              </div>
              <label className="block text-xs text-gray-500">Mic volume: <span className="tabular-nums">{Math.round(local.micVolume * 100)}%</span>
                <input type="range" min="0" max="1.5" step="0.05" value={local.micVolume} className="w-full accent-primary mt-1"
                  onChange={e => set({ micVolume: parseFloat(e.target.value) })} />
              </label>
              <Toggle checked={local.micRawInput} onChange={micRawInput => set({ micRawInput })} label="Raw input"
                detail="Turns off noise suppression, echo cancellation and automatic gain" />
            </div>}
            {local.systemAudio && local.micEnabled && <div>
              <label className="block text-sm text-gray-400 mb-1">Microphone track</label>
              <select aria-label="Microphone track" value={local.micTrack} className={selectStyle}
                onChange={e => set({ micTrack: e.target.value as AppSettings['micTrack'] })}>
                <option value="mixed">Mixed with game audio — one track</option>
                <option value="separate">Separate tracks — mix, game and microphone</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Separate keeps the mix as the default first track, so players and chat apps still play everything; editors get game and voice on tracks 2 and 3. GPU recordings only: the browser recorder writes one track.</p>
            </div>}
          </Section>

          <Section title="Instant replay">
            <label className="block text-sm text-gray-400">Keep the last</label>
            <select aria-label="Replay length" value={local.replaySeconds} className={selectStyle}
              onChange={e => set({ replaySeconds: Number(e.target.value) as ReplaySeconds })}>
              {replayLengths.map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds > 60 ? 's' : ''}`}</option>)}
            </select>
            <Toggle checked={local.replayAutoArm} onChange={replayAutoArm => set({ replayAutoArm })}
              label="Turn on instant replay when SleekRec starts" detail="Uses the last GPU source you recorded or armed. Replay keeps only the last few minutes on disk." />
          </Section>

          <Section title="Hotkeys">
            <p className="text-xs text-gray-500">Global: they work while a game has focus. Click a field and press the keys; Backspace clears it.</p>
            {(Object.keys(hotkeyNames) as HotkeyAction[]).map(action => <div key={action} className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-300">{hotkeyNames[action]}</span>
              <HotkeyInput value={local.hotkeys[action]} unavailable={!!hotkeyStatus[action] && local.hotkeys[action] === settings.hotkeys[action]}
                onChange={value => setLocal(prev => ({ ...prev, hotkeys: { ...prev.hotkeys, [action]: value } }))} />
            </div>)}
          </Section>

          <Section title="Startup and tray">
            <Toggle checked={local.startMinimized} onChange={startMinimized => set({ startMinimized })} label="Start minimized to the tray" />
            <Toggle checked={local.closeToTray} onChange={closeToTray => set({ closeToTray })} label="Keep running in the tray when the window closes"
              detail="Hotkeys and instant replay keep working; quit from the tray menu." />
            <Toggle checked={local.launchAtLogin} onChange={launchAtLogin => set({ launchAtLogin })} label="Start SleekRec when you sign in"
              detail="Starts in the tray. Installed builds only." />
          </Section>

          <Section title="Storage">
            <label className="block text-sm text-gray-400">Output folder</label>
            <div className="flex gap-2">
              <div className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-300 truncate" title={local.outputFolder}>{local.outputFolder}</div>
              <button onClick={() => { void window.electronAPI.selectOutputFolder().then(folder => { if (folder) set({ outputFolder: folder }) }) }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors">Browse</button>
            </div>
            <label className="block text-sm text-gray-400">Source thumbnail columns</label>
            <div className="flex gap-2">
              {[2, 3, 4].map(cols => <button key={cols} onClick={() => set({ columnCount: cols })}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${local.columnCount === cols
                  ? 'bg-primary text-black' : 'bg-gray-700/50 text-gray-300 hover:bg-gray-600/50'}`}>{cols} columns</button>)}
            </div>
          </Section>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-800">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors">Cancel</button>
          <button onClick={() => {
            // The remembered source changes with every start; the dialog's copy may be stale.
            const { lastSource: _remembered, ...changes } = local
            onSave(changes)
            onClose()
          }}
            className="flex-1 py-2 rounded-lg bg-primary hover:bg-primary/80 text-black font-medium text-sm transition-colors">Save</button>
        </div>
      </div>
    </div>
  )
}
