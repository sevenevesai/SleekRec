import { useState, useEffect, useRef, useCallback } from 'react'
import { CaptureAudio } from './capture-audio'
import { CaptureSource, CaptureInfo, RecordingStats, SavedRecording, NativeCapabilities,
  FrameRate, captureBitrate, requestedFps, qualityPresets, captureEngineForSource } from './recording'

// Settings Modal Component
function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSave
}: {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings
  onSave: (settings: Partial<AppSettings>) => void
}) {
  const [localSettings, setLocalSettings] = useState(settings)
  const [presets, setPresets] = useState<Record<QualityPreset, QualityPresetConfig> | null>(null)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [micLevel, setMicLevel] = useState(0)
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null)
  const micMeterRef = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null)
  const micMeterGenerationRef = useRef(0)

  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  useEffect(() => {
    if (!isOpen) return
    window.electronAPI.getQualityPresets().then(setPresets)
    window.electronAPI.nativeCapabilities().then(setCapabilities)
    refreshMicDevices()

    const handleDeviceChange = () => { refreshMicDevices() }
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      stopMicMeter()
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && localSettings.micEnabled && localSettings.micDeviceId !== undefined) {
      startMicMeter()
    } else {
      stopMicMeter()
    }
    return () => { stopMicMeter() }
  }, [isOpen, localSettings.micEnabled, localSettings.micDeviceId])

  const startMicMeter = async () => {
    stopMicMeter()
    const generation = micMeterGenerationRef.current
    try {
      const constraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      if (localSettings.micDeviceId) {
        constraints.deviceId = { exact: localSettings.micDeviceId }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      if (generation !== micMeterGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const tick = () => {
        if (generation !== micMeterGenerationRef.current || !micMeterRef.current) return
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
        setMicLevel(sum / dataArray.length / 255)
        micMeterRef.current!.raf = requestAnimationFrame(tick)
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
      micMeterRef.current.ctx.close()
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

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI.selectOutputFolder()
    if (folder) {
      setLocalSettings(prev => ({ ...prev, outputFolder: folder }))
    }
  }

  const handleSave = () => {
    onSave(localSettings)
    onClose()
  }

  if (!isOpen) return null

  const qualityOptions: { value: QualityPreset; label: string; desc: string }[] = [
    { value: 'low', label: 'Low', desc: 'Smallest files, good for quick shares' },
    { value: 'medium', label: 'Medium', desc: 'Balanced quality and size' },
    { value: 'high', label: 'High', desc: 'High quality, larger files' },
    { value: 'ultra', label: 'Ultra', desc: 'Maximum GPU master quality; very large files' }
  ]

  const currentPreset = presets?.[localSettings.qualityPreset]

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-xl font-semibold text-white mb-6">Settings</h2>

        {/* Quality Preset */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-2">Recording Quality</label>
          <div className="grid grid-cols-4 gap-2">
            {qualityOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setLocalSettings(prev => ({ ...prev, qualityPreset: opt.value }))}
                className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                  localSettings.qualityPreset === opt.value
                    ? 'bg-primary text-white'
                    : 'bg-gray-700/50 text-gray-300 hover:bg-gray-600/50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {currentPreset && (
            <p className="text-xs text-gray-500 mt-2">
              {qualityOptions.find(option => option.value === localSettings.qualityPreset)?.desc}.
              {localSettings.qualityPreset === 'ultra'
                ? ' GPU capture keeps full color detail with lossless encoding after color conversion. Window/browser recording remains lossy.'
                : ` GPU recording uses constant QP ${currentPreset.qp}; file size varies with motion and detail.`}
            </p>
          )}
        </div>

        <div className="mb-6 space-y-3">
          <label className="block text-sm text-gray-400">Recorder</label>
          <select aria-label="Recorder" value={localSettings.recordingEngine}
            onChange={e => setLocalSettings(prev => ({ ...prev, recordingEngine: e.target.value as AppSettings['recordingEngine'] }))}
            className="w-full bg-gray-800 rounded-lg px-3 py-2 text-sm">
            <option value="auto">Automatic — GPU for supported screens</option>
            <option value="native">GPU screen recording — Windows / NVIDIA</option>
            <option value="browser">Browser — windows and other platforms</option>
          </select>
          {capabilities?.reason && <p className="text-xs text-yellow-300">{capabilities.reason}</p>}
          <label className="block text-sm text-gray-400">Frame rate at source resolution</label>
          <select aria-label="Frame rate" value={localSettings.frameRate}
            onChange={e => setLocalSettings(prev => ({ ...prev, frameRate: e.target.value === 'display' ? 'display' : Number(e.target.value) as FrameRate }))}
            className="w-full bg-gray-800 rounded-lg px-3 py-2 text-sm">
            <option value="display">Match display refresh (up to 240 fps)</option>
            {[30, 60, 90, 120, 144, 165, 240].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}
          </select>
          <p className="text-xs text-gray-500">Full-screen games: select the screen. Actual frame delivery depends on GPU headroom; watch the live rate during motion. GPU capture currently records SDR.</p>
          <label className="block text-sm text-gray-400">GPU master codec</label>
          <select aria-label="GPU master codec" value={localSettings.nativeCodec}
            onChange={e => setLocalSettings(prev => ({ ...prev, nativeCodec: e.target.value as AppSettings['nativeCodec'] }))}
            className="w-full bg-gray-800 rounded-lg px-3 py-2 text-sm">
            <option value="h264">H.264</option>
            <option value="hevc">HEVC</option>
          </select>
          <p className="text-xs text-gray-500">GPU recordings save an MKV master directly. Ultra uses 4:4:4 video and can exceed several GB per minute; playback needs a compatible player/editor. Smaller MP4 makes a widely compatible copy. High uses ordinary 4:2:0 video.</p>
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={localSettings.systemAudio}
              onChange={e => setLocalSettings(prev => ({ ...prev, systemAudio: e.target.checked }))} />
            System / game audio
          </label>
        </div>

        {/* Microphone */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-2">Microphone</label>
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={() => setLocalSettings(prev => ({ ...prev, micEnabled: !prev.micEnabled }))}
              className={`relative w-10 h-6 rounded-full transition-colors ${
                localSettings.micEnabled ? 'bg-primary' : 'bg-gray-600'
              }`}
            >
              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                localSettings.micEnabled ? 'left-5' : 'left-1'
              }`} />
            </button>
            <span className="text-sm text-gray-300">
              {localSettings.micEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          {localSettings.micEnabled && (
            <>
              <select
                value={localSettings.micDeviceId ?? ''}
                onChange={e => setLocalSettings(prev => ({
                  ...prev,
                  micDeviceId: e.target.value || null
                }))}
                className="w-full bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-300 mb-3 border border-gray-700 focus:border-primary focus:outline-none"
              >
                <option value="">Default microphone</option>
                {micDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>

              {/* Level meter */}
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">Input Level</label>
                <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-75"
                    style={{
                      width: `${Math.min(micLevel * 100, 100)}%`,
                      backgroundColor: micLevel > 0.8 ? '#ef4444' : micLevel > 0.5 ? '#eab308' : '#22c55e'
                    }}
                  />
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">
                  Mic Volume: {Math.round(localSettings.micVolume * 100)}%
                </label>
                <input
                  type="range"
                  min="0"
                  max="1.5"
                  step="0.05"
                  value={localSettings.micVolume}
                  onChange={e => setLocalSettings(prev => ({
                    ...prev,
                    micVolume: parseFloat(e.target.value)
                  }))}
                  className="w-full accent-primary"
                />
              </div>

              {/* Raw input toggle */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setLocalSettings(prev => ({ ...prev, micRawInput: !prev.micRawInput }))}
                  className={`relative w-10 h-6 rounded-full transition-colors ${
                    localSettings.micRawInput ? 'bg-primary' : 'bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                    localSettings.micRawInput ? 'left-5' : 'left-1'
                  }`} />
                </button>
                <div>
                  <span className="text-sm text-gray-300">Raw input</span>
                  <p className="text-xs text-gray-500">Disable noise suppression &amp; echo cancellation</p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Output Folder */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-2">Output Folder</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-300 truncate">
              {localSettings.outputFolder}
            </div>
            <button
              onClick={handleSelectFolder}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Column Count */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-2">Thumbnail Columns</label>
          <div className="flex gap-2">
            {[2, 3, 4].map(cols => (
              <button
                key={cols}
                onClick={() => setLocalSettings(prev => ({ ...prev, columnCount: cols }))}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  localSettings.columnCount === cols
                    ? 'bg-primary text-white'
                    : 'bg-gray-700/50 text-gray-300 hover:bg-gray-600/50'
                }`}
              >
                {cols} cols
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2 rounded-lg bg-primary hover:bg-primary/80 text-white text-sm transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

type Session = {
  id: string
  engine: 'native' | 'browser'
  recorder?: MediaRecorder
  stopped?: Promise<void>
}

function MainApp() {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [settings, setSettings] = useState<AppSettings>({ outputFolder: '', qualityPreset: 'medium',
    recordingEngine: 'auto', frameRate: 'display', nativeCodec: 'h264', systemAudio: true,
    columnCount: 2, micEnabled: false, micDeviceId: null, micVolume: 0.8, micRawInput: false })
  const [loaded, setLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [timer, setTimer] = useState(0)
  const [sourceName, setSourceName] = useState('')
  const [info, setInfo] = useState<CaptureInfo | null>(null)
  const [stats, setStats] = useState<RecordingStats | null>(null)
  const [saved, setSaved] = useState<SavedRecording | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<CaptureAudio | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const micVolumeRef = useRef(0.8)
  const isMicMutedRef = useRef(false)
  const isPausedRef = useRef(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const operationRef = useRef(false)
  const stopRequestedRef = useRef(false)
  const elapsedRef = useRef(0)
  const sinceRef = useRef(0)
  const timerRef = useRef(0)
  const stopRef = useRef<() => Promise<void>>(async () => {})

  const syncTimer = useCallback(() => {
    window.electronAPI.syncTimer({ timer: timerRef.current, isPaused: isPausedRef.current,
      isMicMuted: isMicMutedRef.current, hasMic: !!micGainRef.current })
  }, [])
  const releaseMedia = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    streamRef.current?.getTracks().forEach(track => { track.onended = null; track.stop() })
    streamRef.current = null
    audioRef.current?.close()
    audioRef.current = null
    micGainRef.current = null
    isMicMutedRef.current = false
    isPausedRef.current = false
    sessionRef.current = null
  }, [])
  const fail = useCallback((message: string) => {
    setError(message)
    void stopRef.current()
  }, [])

  const handleStop = useCallback(async () => {
    if (operationRef.current) { stopRequestedRef.current = true; return }
    const session = sessionRef.current
    if (!session) return
    operationRef.current = true
    if (intervalRef.current) clearInterval(intervalRef.current)
    setBusy('Finishing recording...')
    window.electronAPI.hideOverlay()
    try {
      let result: SavedRecording
      if (session.engine === 'native') {
        result = await window.electronAPI.nativeStop(session.id)
      } else {
        if (session.recorder?.state !== 'inactive') session.recorder?.stop()
        // onstop awaits the ordered chunk writes and the main-process flush.
        await session.stopped
        result = await window.electronAPI.stopSave(session.id)
      }
      setSaved(result)
    } catch (e) {
      setError(`Could not finish recording: ${String(e)}. Any recoverable parts remain in the output folder.`)
      await window.electronAPI.abortRecording().catch(() => {})
    } finally {
      releaseMedia()
      setIsRecording(false)
      setIsPaused(false)
      setBusy('')
      operationRef.current = false
      stopRequestedRef.current = false
      window.electronAPI.restore()
    }
  }, [releaseMedia])
  stopRef.current = handleStop

  const handlePause = useCallback(async () => {
    const session = sessionRef.current
    if (!session || operationRef.current) return
    operationRef.current = true
    setBusy(isPausedRef.current ? 'Resuming...' : 'Pausing...')
    try {
      if (isPausedRef.current) {
        if (session.engine === 'native') {
          await window.electronAPI.nativeResume(session.id)
          await audioRef.current?.startPCM(session.id, e => fail(e.message))
          await window.electronAPI.nativeReady(session.id)
        } else session.recorder?.resume()
        sinceRef.current = performance.now()
        isPausedRef.current = false
      } else {
        if (session.engine === 'native') {
          await window.electronAPI.nativePause(session.id)
          await audioRef.current?.pausePCM()
        } else session.recorder?.pause()
        elapsedRef.current += performance.now() - sinceRef.current
        isPausedRef.current = true
      }
      setIsPaused(isPausedRef.current)
      syncTimer()
    } catch (e) {
      setError(String(e))
      stopRequestedRef.current = true
    } finally {
      setBusy('')
      operationRef.current = false
      if (stopRequestedRef.current) void stopRef.current()
    }
  }, [fail, syncTimer])

  const handleMicToggle = useCallback(() => {
    if (!micGainRef.current) return
    isMicMutedRef.current = !isMicMutedRef.current
    micGainRef.current.gain.value = isMicMutedRef.current ? 0 : micVolumeRef.current
    syncTimer()
  }, [syncTimer])

  useEffect(() => {
    let alive = true
    window.electronAPI.getSettings().then(s => { if (alive) { setSettings(s); setLoaded(true) } }).catch(e => setError(String(e)))
    let lastRefresh = -Infinity
    const refresh = () => {
      if (operationRef.current || sessionRef.current) return
      lastRefresh = performance.now()
      window.electronAPI.getSources().then(s => { if (alive) setSources(s) }).catch(e => { if (alive) setError(String(e)) })
    }
    // Sources load on mount, on demand and on focus, never on a timer: each refresh spawns the
    // native helper twice. backgroundThrottling: false disables the Page Visibility API, hence focus.
    const refreshOnFocus = () => { if (performance.now() - lastRefresh >= 2000) refresh() }
    refresh()
    window.addEventListener('focus', refreshOnFocus)
    return () => { alive = false; window.removeEventListener('focus', refreshOnFocus) }
  }, [])
  useEffect(() => {
    const listeners = [window.electronAPI.onStopRecording(() => { void handleStop() }),
      window.electronAPI.onPauseRecording(() => { void handlePause() }),
      window.electronAPI.onMicToggle(handleMicToggle), window.electronAPI.onRecordingStats(setStats),
      window.electronAPI.onRecordingError(fail)]
    return () => listeners.forEach(remove => remove())
  }, [handleStop, handlePause, handleMicToggle, fail])

  const handleStart = async (source: CaptureSource) => {
    if (!loaded || operationRef.current || sessionRef.current) return
    operationRef.current = true
    stopRequestedRef.current = false
    setBusy('Starting capture...')
    setError('')
    setStats(null)
    setSaved(null)
    try {
      const native = captureEngineForSource(source, settings.recordingEngine) === 'native'
      const audio = new CaptureAudio()
      audioRef.current = audio
      let captureInfo: CaptureInfo
      if (native) {
        await audio.open(settings, undefined, source.id)
        const prepared = await window.electronAPI.prepareNative(source.id)
        sessionRef.current = { id: prepared.id, engine: 'native' }
        await audio.startPCM(prepared.id, e => fail(e.message))
        await window.electronAPI.nativeReady(prepared.id)
        captureInfo = prepared.info
      } else {
        const targetFps = requestedFps(settings.frameRate, source.refreshRate)
        const desktop = await navigator.mediaDevices.getUserMedia({
          audio: settings.systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } as MediaTrackConstraints : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id,
            maxWidth: source.width || 16384, maxHeight: source.height || 16384, maxFrameRate: targetFps } } as MediaTrackConstraints,
        })
        streamRef.current = desktop
        const track = desktop.getVideoTracks()[0]
        track.contentHint = 'motion'
        track.onended = () => fail('The selected capture source has closed.')
        await audio.open(settings, desktop)
        const tracks = track.getSettings()
        const width = tracks.width || 1920
        const height = tracks.height || 1080
        const fps = tracks.frameRate || targetFps
        const h264 = ['video/x-matroska;codecs=avc1', 'video/webm;codecs=h264'].find(type => MediaRecorder.isTypeSupported(type))
        const mimeType = h264 || 'video/webm;codecs=vp9'
        if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('No supported recording codec is available')
        const recording = new MediaStream([track, ...(audio.output?.getAudioTracks() || [])])
        const bitrate = captureBitrate(settings.qualityPreset, width, height, fps)
        const recorder = new MediaRecorder(recording, { mimeType, videoBitsPerSecond: bitrate,
          audioBitsPerSecond: parseInt(qualityPresets[settings.qualityPreset].audioBitrate) * 1000 })
        captureInfo = { engine: 'browser', codec: h264 ? 'H.264' : 'VP9', width, height, targetFps,
          captureFps: fps, bitrate: recorder.videoBitsPerSecond, sourceId: source.id, sourceName: source.name,
          quality: 'lossy-420' }
        const id = await window.electronAPI.startSave(h264 ? 'h264' : 'vp9', captureInfo)
        let pending = Promise.resolve()
        let queued = 0
        let writeError: unknown
        let resolveStop!: () => void
        let rejectStop!: (error: unknown) => void
        const stopped = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject })
        void stopped.catch(() => {})
        recorder.ondataavailable = event => {
          if (!event.data.size) return
          const blob = event.data
          queued += blob.size
          if (queued > 64 * 1024 * 1024) {
            writeError = new Error('The disk cannot keep up with capture; the 64 MB write queue is full.')
            fail(String(writeError))
            return
          }
          pending = pending.then(async () => {
            if (writeError) return
            await window.electronAPI.saveChunk(id, await blob.arrayBuffer())
          }).catch(e => { writeError = e; fail(String(e)) }).finally(() => { queued -= blob.size })
        }
        recorder.onstop = async () => {
          try {
            await pending
            if (writeError) throw writeError
            await window.electronAPI.flushChunks(id)
            resolveStop()
          } catch (e) { rejectStop(e) }
        }
        recorder.onerror = () => fail('The browser encoder failed. Try GPU capture for a screen or a lower frame rate.')
        sessionRef.current = { id, engine: 'browser', recorder, stopped }
        recorder.start(1000)
      }
      micGainRef.current = audio.micGain
      micVolumeRef.current = settings.micVolume
      isMicMutedRef.current = false
      isPausedRef.current = false
      elapsedRef.current = 0
      sinceRef.current = performance.now()
      timerRef.current = 0
      setInfo(captureInfo)
      setSourceName(source.name)
      setTimer(0)
      setIsRecording(true)
      setIsPaused(false)
      intervalRef.current = setInterval(() => {
        const elapsed = elapsedRef.current + (isPausedRef.current ? 0 : performance.now() - sinceRef.current)
        timerRef.current = Math.floor(elapsed / 1000)
        setTimer(timerRef.current)
        syncTimer()
      }, 500)
      window.electronAPI.showOverlay()
      syncTimer()
    } catch (e) {
      setError(String(e))
      await window.electronAPI.abortRecording().catch(() => {})
      releaseMedia()
      setIsRecording(false)
    } finally {
      operationRef.current = false
      setBusy('')
      if (stopRequestedRef.current) void handleStop()
    }
  }

  const saveSettings = async (changes: Partial<AppSettings>) => {
    try { setSettings(await window.electronAPI.saveSettings(changes)) }
    catch (e) { setError(String(e)) }
  }
  const exportRecording = async (mode: 'copy' | 'small') => {
    if (operationRef.current) return
    operationRef.current = true
    setBusy(mode === 'copy' ? 'Exporting MP4 without changing video quality...' : 'Creating a smaller MP4 copy...')
    setError('')
    try { await window.electronAPI.exportRecording(mode) }
    catch (e) { setError(String(e)) }
    finally { setBusy(''); operationRef.current = false }
  }
  const formatTime = (seconds: number) => `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  const buttonStyle = 'clickable rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700 disabled:opacity-40'

  return <div className="h-screen bg-background text-white flex flex-col overflow-y-auto">
    <header className="p-6 pb-4 flex justify-between items-center draggable shrink-0">
      <div><h1 className="text-2xl font-light tracking-wide">Sleek<span className="font-bold text-primary">Rec</span></h1>
        <p className="text-xs text-gray-500 mt-1">{isRecording ? sourceName : 'Select a screen or window to record'}</p></div>
      {!isRecording && <div className="flex gap-2">
        <button className={buttonStyle} disabled={!!busy || !loaded} onClick={() => {
          void window.electronAPI.getSources().then(setSources).catch(e => setError(String(e)))
        }}>Refresh sources</button>
        <button className={buttonStyle} disabled={!!busy || !loaded} onClick={() => setShowSettings(true)}>Settings</button>
      </div>}
    </header>
    {error && <div role="alert" className="mx-6 mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-200 whitespace-pre-wrap break-words">{error}</div>}
    {busy && <div role="status" className="mx-6 mb-4 p-3 bg-primary/10 text-primary rounded-lg text-sm">{busy}</div>}
    {isRecording ? <main className="flex-1 flex flex-col items-center justify-center p-6">
      <div className={`w-3 h-3 rounded-full mb-4 ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`} />
      <div className="font-mono text-5xl mb-4">{formatTime(timer)}</div>
      <p className="text-gray-400 mb-2">{isPaused ? 'Paused' : 'Recording'} · {info?.width} × {info?.height} · target {info?.targetFps} fps</p>
      <p className="text-sm text-gray-500">{info?.codec} · {info?.engine === 'native' ? 'GPU capture · MKV master' : 'Browser capture'}</p>
      {info?.quality === 'lossless-444' && <p className="text-xs text-gray-400 mt-2">Ultra · full color detail · lossless encoding after color conversion</p>}
      {stats && <p className="mt-3 text-lg">{Math.round(stats.fps)} fps encoded · {(stats.bytes / 1_000_000).toFixed(0)} MB</p>}
      {stats?.pacing && <p className="text-xs text-gray-400 mt-2">Encoded frame gaps: 95% ≤ {stats.pacing.p95GapMs} ms · longest {Math.round(stats.pacing.maxGapMs)} ms · {stats.pacing.gapsOver100ms} over 100 ms</p>}
      {stats?.warning && <p className="text-yellow-300 text-sm mt-3 max-w-lg text-center">{stats.warning}</p>}
      {info?.engine === 'browser' && <p className="text-xs text-gray-500 mt-3">Capture reports {info.captureFps?.toFixed(1)} fps; actual encoded delivery may be lower.</p>}
      <div className="flex gap-3 mt-8">
        <button className={buttonStyle} onClick={() => { void handlePause() }} disabled={!!busy}>{isPaused ? 'Resume' : 'Pause'}</button>
        <button className="clickable rounded-lg bg-red-600 px-6 py-2 text-sm disabled:opacity-40" onClick={() => { void handleStop() }} disabled={!!busy}>Stop and save</button>
      </div>
      <p className="text-xs text-gray-500 mt-6">Ctrl+Shift+F9: stop · Ctrl+Shift+F10: pause/resume</p>
    </main> : <main className="p-6 pt-0">
      <div className="mb-5 flex flex-wrap gap-2 text-xs text-gray-400">
        <span className="bg-surface px-3 py-2 rounded-lg">{settings.qualityPreset.toUpperCase()} · {settings.frameRate === 'display' ? 'Display refresh' : `${settings.frameRate} fps`} · source resolution</span>
        <span className="bg-surface px-3 py-2 rounded-lg">System audio {settings.systemAudio ? 'on' : 'off'} · Mic {settings.micEnabled ? 'on' : 'off'}</span>
      </div>
      {saved && <div className="mb-5 p-3 bg-primary/10 rounded-lg text-sm break-all">Saved: {saved.path}
        <p className="mt-1 text-xs text-gray-400">{saved.info.width}×{saved.info.height} · {saved.info.engine === 'native' ? 'GPU' : 'Browser'} recording. Your master is kept when you export a copy.</p>
        {saved.stats?.pacing && <p className="mt-1 text-xs text-gray-300">{saved.stats.pacing.averageFps.toFixed(1)} fps average · {saved.stats.pacing.gapsOver100ms} frame gaps over 100 ms · longest {Math.round(saved.stats.pacing.maxGapMs)} ms</p>}
      </div>}
      {settings.qualityPreset === 'ultra' && <p className="mb-5 text-sm text-gray-300">For smooth high-refresh gameplay, choose a GPU screen. Ultra keeps its full resolution and color detail. Window capture can deliver much lower frame rates.</p>}
      {[{ name: 'Screens', items: sources.filter(s => s.id.startsWith('screen:')) },
        { name: 'Windows', items: sources.filter(s => !s.id.startsWith('screen:')) }].map(group => group.items.length > 0 && <section key={group.name} className="mb-6">
        <h2 className="text-sm text-gray-300 mb-3">{group.name}{group.name === 'Screens' ? ' · recommended for games; records everything visible' : ' · records only the selected window'}</h2>
        <div className={`grid ${{ 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[settings.columnCount] || 'grid-cols-2'} gap-4`}>
        {group.items.map(source => {
          const native = settings.recordingEngine !== 'browser' && !!source.nativeDisplay
          const recommended = settings.recordingEngine !== 'browser' && sources.find(s => s.id === source.recommendedScreenId)
          return <div key={source.id} className="bg-surface rounded-lg overflow-hidden">
            <button onClick={() => { void handleStart(source) }} disabled={!!busy || !loaded || (settings.recordingEngine === 'native' && !native)}
            className="clickable group relative w-full aspect-video rounded-lg overflow-hidden border border-transparent hover:border-primary/50 text-left disabled:opacity-40">
            <img src={source.thumbnail} alt="" className="w-full h-full object-cover opacity-60 group-hover:opacity-100" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/20 to-transparent p-3 flex flex-col justify-end">
              <span className="text-sm truncate">{source.name}</span>
              <span className={`text-xs mt-1 ${native ? 'text-primary' : 'text-gray-400'}`}>
                {native ? 'GPU capture' : settings.recordingEngine === 'auto' && source.gpuUnavailableReason ? 'GPU capture unavailable' : 'Browser capture'}{source.width ? ` · ${source.width}×${source.height}` : ''} · {requestedFps(settings.frameRate, source.refreshRate)} fps target
              </span>
            </div>
            </button>
            {recommended && <button className="clickable w-full px-3 py-2 text-xs text-primary text-left hover:bg-primary/10 disabled:opacity-40" disabled={!!busy || !loaded}
              onClick={() => { void handleStart(recommended) }}>Record entire {recommended.name} instead · GPU · {requestedFps(settings.frameRate, recommended.refreshRate)} fps target</button>}
          </div>
        })}
        </div>
      </section>)}
      <div className="mt-6 pt-4 border-t border-gray-800 flex gap-3 items-center flex-wrap">
        <span className="text-xs text-gray-500">Export an existing recording</span>
        <button className={buttonStyle} disabled={!!busy} onClick={() => { void exportRecording('copy') }}>MP4 · same video quality</button>
        <button className={buttonStyle} disabled={!!busy} onClick={() => { void exportRecording('small') }}>Smaller MP4</button>
      </div>
    </main>}
    <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} settings={settings} onSave={saveSettings} />
  </div>
}

export default MainApp
