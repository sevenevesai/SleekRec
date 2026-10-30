import { useState, useEffect, useRef, useCallback } from 'react'
import { CaptureAudio } from './capture-audio'
import { CaptureSource, CaptureInfo, CaptureRegion, JobProgress, LibraryEntry, MediaDetails, NativeCapabilities, RecordingStats,
  SavedRecording, SourceRef, captureBitrate, captureEngineForSource, defaultHotkeys, encoderLabels, gpuSupport, qualityPresets,
  errorMessage, requestedFps } from './recording'
import { SettingsModal, formatSeconds, hotkeyLabel } from './SettingsModal'
import { RecordingsPanel, formatBytes } from './RecordingsPanel'
import { TrimEditor } from './TrimEditor'

type NativeOptions = { region?: CaptureRegion; windowArea?: boolean }

type Session = {
  id: string
  engine: 'native' | 'browser'
  recorder?: MediaRecorder
  stopped?: Promise<void>
  /** Hotkey and tray starts happen inside games: their stop must not pull SleekRec to the front. */
  origin: 'ui' | 'hotkey'
}

type Replay = { id: string; info: CaptureInfo; source: SourceRef; buffered: number }

const initialSettings: AppSettings = { outputFolder: '', qualityPreset: 'medium', recordingEngine: 'auto', frameRate: 'display',
  nativeCodec: 'h264', systemAudio: true, columnCount: 2, micEnabled: false, micDeviceId: null, micVolume: 0.8, micRawInput: false,
  micTrack: 'mixed', hotkeys: { ...defaultHotkeys }, replaySeconds: 120, replayAutoArm: false, startMinimized: false,
  closeToTray: false, launchAtLogin: false, lastSource: null }

function sourceLabel(source: CaptureSource, options: NativeOptions): string {
  if (options.region) return `${options.region.width}×${options.region.height} area of ${source.name}`
  if (options.windowArea) return `${source.name} (window area)`
  return source.name
}

/** The remembered source in the current list; a window whose handle changed matches a unique title. */
function findSource(sources: CaptureSource[], ref: SourceRef): CaptureSource | undefined {
  const exact = sources.find(s => s.id === ref.id)
  if (exact || !ref.id.startsWith('window:')) return exact
  const title = ref.name.replace(/ \(window area\)$/, '')
  const matches = sources.filter(s => s.id.startsWith('window:') && s.name === title)
  return matches.length === 1 ? matches[0] : undefined
}

const STILL_BUSY = 'SleekRec is still busy. Try again in a moment.'

function MainApp() {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [loaded, setLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<'record' | 'recordings'>('record')
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [timer, setTimer] = useState(0)
  const [sourceName, setSourceName] = useState('')
  const [info, setInfo] = useState<CaptureInfo | null>(null)
  const [stats, setStats] = useState<RecordingStats | null>(null)
  const [saved, setSaved] = useState<SavedRecording | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [replay, setReplay] = useState<Replay | null>(null)
  const [job, setJob] = useState<JobProgress | null>(null)
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null)
  const [trimming, setTrimming] = useState<{ entry: LibraryEntry; details?: MediaDetails } | null>(null)
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
  const settingsRef = useRef(settings)
  const replayRef = useRef<Replay | null>(null)
  const replayAudioRef = useRef<CaptureAudio | null>(null)
  const disarmingRef = useRef<Promise<void> | null>(null)
  const resumeReplayRef = useRef<SourceRef | null>(null)
  const startRef = useRef<(source: CaptureSource, options?: NativeOptions, origin?: Session['origin']) => Promise<void>>(async () => {})
  const armRef = useRef<(source: CaptureSource, options?: NativeOptions, quiet?: boolean) => Promise<void>>(async () => {})
  settingsRef.current = settings

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
  const fail = useCallback((text: string) => {
    setError(text)
    void stopRef.current()
  }, [])
  const saveSettings = useCallback(async (changes: Partial<AppSettings>) => {
    try { setSettings(await window.electronAPI.saveSettings(changes)) }
    catch (e) { setError(errorMessage(e)) }
  }, [])
  const refreshSources = useCallback(async (): Promise<CaptureSource[]> => {
    const list = await window.electronAPI.getSources()
    setSources(list)
    return list
  }, [])

  const disarmReplay = useCallback((): Promise<void> => {
    const current = replayRef.current
    if (!current) return disarmingRef.current ?? Promise.resolve()
    replayRef.current = null
    setReplay(null)
    // Taken now: a new arm may replace the ref before this disarm finishes.
    const audio = replayAudioRef.current
    replayAudioRef.current = null
    const done = (async () => {
      // FFmpeg must handle q while PCM still flows, as with a paused segment.
      await window.electronAPI.replayDisarm(current.id).catch(e => setError(`Instant replay: ${errorMessage(e)}`))
      await audio?.pausePCM()
      audio?.close()
    })()
    disarmingRef.current = done
    void done.finally(() => { if (disarmingRef.current === done) disarmingRef.current = null })
    return done
  }, [])

  const resumeReplay = useCallback(async () => {
    const ref = resumeReplayRef.current
    resumeReplayRef.current = null
    if (!ref) return
    const source = findSource(await window.electronAPI.getSources(false).catch(() => []), ref)
    if (source) await armRef.current(source, { region: ref.region, windowArea: ref.windowArea }, true)
    else window.electronAPI.toast(`Instant replay stayed off: ${ref.name} is not available`, 'error')
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
      setHighlight(result.path)
      if (session.origin === 'hotkey') {
        window.electronAPI.toast(`Recording saved · ${formatSeconds(result.stats?.seconds ?? 0)} · ${formatBytes(result.stats?.bytes ?? 0)}`)
      } else setView('recordings')
    } catch (e) {
      setError(`Could not finish recording: ${errorMessage(e)}. Any recoverable parts remain in the output folder.`)
      if (session.origin === 'hotkey') window.electronAPI.toast('Recording could not be saved. Open SleekRec for details.', 'error')
      await window.electronAPI.abortRecording().catch(() => {})
    } finally {
      releaseMedia()
      setIsRecording(false)
      setIsPaused(false)
      setBusy('')
      operationRef.current = false
      stopRequestedRef.current = false
      if (session.origin === 'ui') window.electronAPI.restore()
      void resumeReplay()
    }
  }, [releaseMedia, resumeReplay])
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
      setError(errorMessage(e))
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

  const handleHotkeyRecord = useCallback(async () => {
    if (sessionRef.current) { void stopRef.current(); return }
    if (operationRef.current) { window.electronAPI.toast(STILL_BUSY, 'error'); return }
    const ref = settingsRef.current.lastSource
    if (!ref) {
      window.electronAPI.toast('Start one recording from SleekRec first; the hotkey then records that source.', 'error')
      window.electronAPI.restore()
      return
    }
    // No thumbnails, and no setSources: the picker keeps its list, and the game keeps the frame time.
    const source = findSource(await window.electronAPI.getSources(false).catch(() => []), ref)
    if (!source) {
      window.electronAPI.toast(`${ref.name} is not available. Open SleekRec to choose a source.`, 'error')
      window.electronAPI.restore()
      return
    }
    await startRef.current(source, { region: ref.region, windowArea: ref.windowArea }, 'hotkey')
  }, [])

  const handleReplayToggle = useCallback(async () => {
    if (replayRef.current) {
      await disarmReplay()
      window.electronAPI.toast('Instant replay off')
      return
    }
    if (sessionRef.current) { window.electronAPI.toast('Instant replay cannot turn on during a recording.', 'error'); return }
    if (operationRef.current) { window.electronAPI.toast(STILL_BUSY, 'error'); return }
    const ref = settingsRef.current.lastSource
    const source = ref && findSource(await window.electronAPI.getSources(false).catch(() => []), ref)
    if (!ref || !source) {
      window.electronAPI.toast('Turn on instant replay from a GPU screen in SleekRec first.', 'error')
      window.electronAPI.restore()
      return
    }
    await armRef.current(source, { region: ref.region, windowArea: ref.windowArea }, true)
  }, [disarmReplay])

  useEffect(() => {
    let alive = true
    let autoArmed = false
    window.electronAPI.nativeCapabilities().then(c => { if (alive) setCapabilities(c) }).catch(() => {})
    let lastRefresh = -Infinity
    const refresh = () => {
      if (operationRef.current || sessionRef.current) return
      lastRefresh = performance.now()
      window.electronAPI.getSources().then(list => {
        if (!alive) return
        setSources(list)
        const s = settingsRef.current
        if (!autoArmed && s.replayAutoArm && s.lastSource && !replayRef.current) {
          autoArmed = true
          const source = findSource(list, s.lastSource)
          if (source) void armRef.current(source, { region: s.lastSource.region, windowArea: s.lastSource.windowArea }, true)
          else window.electronAPI.toast(`Instant replay stayed off: ${s.lastSource.name} is not available.`, 'error')
        }
      }).catch(e => { if (alive) setError(errorMessage(e)) })
    }
    // Sources load on mount, on demand and on focus, never on a timer: each refresh spawns the
    // native helper twice. backgroundThrottling: false disables the Page Visibility API, hence focus.
    const refreshOnFocus = () => { if (performance.now() - lastRefresh >= 2000) refresh() }
    window.electronAPI.getSettings().then(s => {
      if (!alive) return
      settingsRef.current = s
      setSettings(s)
      setLoaded(true)
      refresh()
    }).catch(e => { setError(errorMessage(e)); refresh() })
    window.addEventListener('focus', refreshOnFocus)
    return () => { alive = false; window.removeEventListener('focus', refreshOnFocus) }
  }, [])
  useEffect(() => {
    const listeners = [window.electronAPI.onStopRecording(() => { void handleStop() }),
      window.electronAPI.onPauseRecording(() => { void handlePause() }),
      window.electronAPI.onMicToggle(handleMicToggle), window.electronAPI.onRecordingStats(setStats),
      window.electronAPI.onRecordingError(fail),
      window.electronAPI.onHotkeyRecord(() => { void handleHotkeyRecord() }),
      window.electronAPI.onHotkeyReplayToggle(() => { void handleReplayToggle() }),
      window.electronAPI.onReplayOff(() => { void disarmReplay() }),
      window.electronAPI.onFinalizeProgress(fraction => setBusy(`Making the MP4… ${Math.round(fraction * 100)}%`)),
      window.electronAPI.onReplayStatus(buffered => {
        if (replayRef.current) { replayRef.current = { ...replayRef.current, buffered }; setReplay(replayRef.current) }
      }),
      window.electronAPI.onReplaySaved(result => { setHighlight(result.path); setSaved(result) }),
      window.electronAPI.onReplayError(text => {
        setError(`Instant replay stopped: ${text}`)
        void disarmReplay()
      }),
      window.electronAPI.onJobProgress(progress => setJob(progress.done ? null : progress)),
      window.electronAPI.onShowView(next => setView(next))]
    return () => listeners.forEach(remove => remove())
  }, [handleStop, handlePause, handleMicToggle, fail, handleHotkeyRecord, handleReplayToggle, disarmReplay])

  const rememberSource = (source: CaptureSource, options: NativeOptions) => {
    const ref: SourceRef = { id: source.id, name: sourceLabel(source, options),
      ...(options.region ? { region: options.region } : {}), ...(options.windowArea ? { windowArea: true } : {}) }
    if (JSON.stringify(ref) !== JSON.stringify(settingsRef.current.lastSource)) void saveSettings({ lastSource: ref })
  }

  const handleStart = async (source: CaptureSource, options: NativeOptions = {}, origin: Session['origin'] = 'ui') => {
    if (!loaded || operationRef.current || sessionRef.current) return
    operationRef.current = true
    stopRequestedRef.current = false
    setBusy('Starting capture...')
    setError('')
    setStats(null)
    setSaved(null)
    try {
      // Replay and recording share one GPU capture: the buffer stops now and comes back after the save.
      if (replayRef.current) {
        resumeReplayRef.current = replayRef.current.source
        await disarmReplay()
      }
      const current = settingsRef.current
      const native = !!(options.region || options.windowArea) ||
        captureEngineForSource(source, current.recordingEngine, current) === 'native'
      const audio = new CaptureAudio()
      audioRef.current = audio
      let captureInfo: CaptureInfo
      if (native) {
        await audio.open(current, undefined, source.id)
        const prepared = await window.electronAPI.prepareNative(source.id, options)
        sessionRef.current = { id: prepared.id, engine: 'native', origin }
        await audio.startPCM(prepared.id, e => fail(e.message))
        await window.electronAPI.nativeReady(prepared.id)
        captureInfo = prepared.info
      } else {
        const targetFps = requestedFps(current.frameRate, source.refreshRate)
        const desktop = await navigator.mediaDevices.getUserMedia({
          audio: current.systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } as MediaTrackConstraints : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id,
            maxWidth: source.width || 16384, maxHeight: source.height || 16384, maxFrameRate: targetFps } } as MediaTrackConstraints,
        })
        streamRef.current = desktop
        const track = desktop.getVideoTracks()[0]
        track.contentHint = 'motion'
        track.onended = () => fail('The selected capture source has closed.')
        await audio.open(current, desktop)
        const tracks = track.getSettings()
        const width = tracks.width || 1920
        const height = tracks.height || 1080
        const fps = tracks.frameRate || targetFps
        const h264 = ['video/x-matroska;codecs=avc1', 'video/webm;codecs=h264'].find(type => MediaRecorder.isTypeSupported(type))
        const mimeType = h264 || 'video/webm;codecs=vp9'
        if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('No supported recording codec is available')
        const recording = new MediaStream([track, ...(audio.output?.getAudioTracks() || [])])
        const bitrate = captureBitrate(current.qualityPreset, width, height, fps)
        const recorder = new MediaRecorder(recording, { mimeType, videoBitsPerSecond: bitrate,
          audioBitsPerSecond: parseInt(qualityPresets[current.qualityPreset].audioBitrate) * 1000 })
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
        sessionRef.current = { id, engine: 'browser', recorder, stopped, origin }
        recorder.start(1000)
      }
      rememberSource(source, options)
      micGainRef.current = audio.micGain
      micVolumeRef.current = current.micVolume
      isMicMutedRef.current = false
      isPausedRef.current = false
      elapsedRef.current = 0
      sinceRef.current = performance.now()
      timerRef.current = 0
      setInfo(captureInfo)
      setSourceName(sourceLabel(source, options))
      setTimer(0)
      setIsRecording(true)
      setIsPaused(false)
      setView('record')
      intervalRef.current = setInterval(() => {
        const elapsed = elapsedRef.current + (isPausedRef.current ? 0 : performance.now() - sinceRef.current)
        const seconds = Math.floor(elapsed / 1000)
        if (seconds === timerRef.current) return
        timerRef.current = seconds
        setTimer(seconds)
        syncTimer()
      }, 500)
      window.electronAPI.showOverlay()
      syncTimer()
      if (origin === 'hotkey') window.electronAPI.toast(`Recording ${sourceLabel(source, options)}`)
    } catch (e) {
      setError(errorMessage(e))
      if (origin === 'hotkey') {
        window.electronAPI.toast(`Recording did not start: ${errorMessage(e).split('\n')[0]}`, 'error')
        window.electronAPI.restore()
      }
      await window.electronAPI.abortRecording().catch(() => {})
      releaseMedia()
      setIsRecording(false)
      void resumeReplay()
    } finally {
      operationRef.current = false
      setBusy('')
      if (stopRequestedRef.current) void handleStop()
    }
  }
  startRef.current = handleStart

  const armReplay = async (source: CaptureSource, options: NativeOptions = {}, quiet = false) => {
    // The previous buffer must finish stopping (and its save) before a new one starts.
    await disarmingRef.current
    if (!loaded || replayRef.current || sessionRef.current || operationRef.current) return
    operationRef.current = true
    setBusy('Turning on instant replay…')
    setError('')
    const audio = new CaptureAudio()
    let armedId: string | undefined
    try {
      await audio.open(settingsRef.current, undefined, source.id)
      const armed = await window.electronAPI.replayArm(source.id, options)
      armedId = armed.id
      replayAudioRef.current = audio
      await audio.startPCM(armed.id, e => {
        if (replayRef.current?.id !== armed.id) return
        setError(`Instant replay stopped: ${e.message}`)
        void disarmReplay()
      })
      await window.electronAPI.nativeReady(armed.id)
      replayRef.current = { id: armed.id, info: armed.info, buffered: 0,
        source: { id: source.id, name: sourceLabel(source, options), ...options } }
      setReplay(replayRef.current)
      rememberSource(source, options)
      if (quiet) window.electronAPI.toast(`Instant replay on · ${hotkeyLabel(settingsRef.current.hotkeys.replaySave) || 'tray menu'} saves`)
    } catch (e) {
      setError(`Instant replay did not start: ${errorMessage(e)}`)
      if (quiet) window.electronAPI.toast('Instant replay did not start. Open SleekRec for details.', 'error')
      if (armedId) await window.electronAPI.replayDisarm(armedId).catch(() => {})
      audio.close()
      replayAudioRef.current = null
    } finally {
      operationRef.current = false
      setBusy('')
    }
  }
  armRef.current = armReplay

  const pickRegion = async (source: CaptureSource, then: 'record' | 'replay') => {
    try {
      const region = await window.electronAPI.pickRegion(source.id)
      if (!region) return
      if (then === 'record') await handleStart(source, { region })
      else await armReplay(source, { region })
    } catch (e) { setError(errorMessage(e)) }
  }

  const formatTime = (seconds: number) => `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  const buttonStyle = 'clickable rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
  const secondaryAction = 'clickable flex-1 px-3 py-2 text-xs text-left hover:bg-primary/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'
  const keys = settings.hotkeys
  const readyAdapters = capabilities?.adapters?.filter(a => a.encoders.h264 || a.encoders.hevc) ?? []
  const tab = (name: typeof view, label: string) => <button role="tab" aria-selected={view === name} onClick={() => setView(name)}
    className={`clickable px-3 py-1.5 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      view === name ? 'bg-primary/15 text-primary' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>

  return <div className="h-screen bg-background text-white flex flex-col overflow-y-auto [scrollbar-gutter:stable]">
    <header className="sticky top-0 z-30 bg-background/95 backdrop-blur px-6 pt-6 pb-3 flex justify-between items-center gap-4 draggable shrink-0">
      <div className="min-w-0"><h1 className="text-2xl font-light tracking-wide">Sleek<span className="font-bold text-primary">Rec</span></h1>
        <p className="text-xs text-gray-500 mt-1 truncate">{isRecording ? sourceName : view === 'record' ? 'Select a screen or window to record' : 'Your recordings, newest first'}</p></div>
      {!isRecording && <nav role="tablist" className="flex gap-1 rounded-lg bg-surface p-1">{tab('record', 'Record')}{tab('recordings', 'Recordings')}</nav>}
      {!isRecording && <div className="flex gap-2">
        {view === 'record' && <button className={buttonStyle} disabled={!!busy || !loaded} onClick={() => {
          void refreshSources().catch(e => setError(errorMessage(e)))
        }}>Refresh sources</button>}
        <button className={buttonStyle} disabled={!!busy || !loaded} onClick={() => setShowSettings(true)}>Settings</button>
      </div>}
    </header>
    <div className="px-6 space-y-3 mb-3 empty:hidden">
      {error && <div role="alert" className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-200 whitespace-pre-wrap break-words flex gap-3">
        <span className="flex-1">{error}</span>
        <button className="clickable text-xs text-red-300 hover:text-white self-start" onClick={() => setError('')}>Dismiss</button></div>}
      {busy && <div role="status" className="p-3 bg-primary/10 text-primary rounded-lg text-sm tabular-nums">{busy}</div>}
      {job && <div role="status" className="p-3 bg-surface rounded-lg text-sm flex items-center gap-3">
        <span className="text-gray-200">{job.label}</span>
        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden"><div className="h-full w-full bg-primary origin-left transition-transform"
          style={{ transform: `scaleX(${job.fraction})` }} /></div>
        <span className="tabular-nums text-gray-400 w-10 text-right">{Math.round(job.fraction * 100)}%</span>
        <button className="clickable text-xs text-gray-400 hover:text-white" onClick={() => { void window.electronAPI.cancelJob() }}>Cancel</button>
      </div>}
      {replay && !isRecording && <div role="status" className="p-3 rounded-lg text-sm border border-secondary/30 bg-secondary/5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2 text-secondary"><span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />Instant replay</span>
        <span className="text-gray-300 tabular-nums">{formatSeconds(replay.buffered)} of {formatSeconds(settings.replaySeconds)} buffered · {replay.source.name}</span>
        <span className="text-xs text-gray-500">{keys.replaySave ? `${hotkeyLabel(keys.replaySave)} saves` : 'Set a save hotkey in Settings'}</span>
        <span className="flex-1" />
        <button className="clickable rounded-md bg-secondary/15 px-3 py-1.5 text-secondary hover:bg-secondary/25" onClick={() => {
          void window.electronAPI.replaySave().catch(e => setError(errorMessage(e)))
        }}>Save replay</button>
        <button className="clickable rounded-md px-3 py-1.5 text-gray-400 hover:text-white" onClick={() => { void disarmReplay() }}>Turn off</button>
      </div>}
      {saved && !isRecording && <div className="p-3 bg-primary/10 rounded-lg text-sm break-all">Saved: {saved.path}
        <p className="mt-1 text-xs text-gray-400">{saved.info.width}×{saved.info.height} · {saved.info.engine === 'native' ? `GPU · ${saved.info.codec}` : 'Browser'} recording{saved.info.kind === 'replay' ? ' · instant replay' : ''}</p>
        {saved.stats?.pacing && <p className="mt-1 text-xs text-gray-300 tabular-nums">{saved.stats.pacing.averageFps.toFixed(1)} fps average · {saved.stats.pacing.gapsOver100ms} frame gaps over 100 ms · longest {Math.round(saved.stats.pacing.maxGapMs)} ms</p>}
        {saved.warning && <p className="mt-1 text-xs text-yellow-300">{saved.warning}</p>}
      </div>}
    </div>
    {isRecording ? <main className="flex-1 flex flex-col items-center justify-center p-6">
      <div className={`w-3 h-3 rounded-full mb-4 ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`} />
      <div className="font-mono text-5xl mb-4 tabular-nums">{formatTime(timer)}</div>
      <p className="text-gray-400 mb-2 tabular-nums">{isPaused ? 'Paused' : 'Recording'} · {info?.width} × {info?.height} · target {info?.targetFps} fps</p>
      <p className="text-sm text-gray-500">{info?.codec} · {info?.engine === 'native' ? `GPU capture${info.adapterName ? ` on ${info.adapterName}` : ''}` : 'Browser capture'}</p>
      {info?.quality === 'lossless-444' && <p className="text-xs text-gray-400 mt-2">Ultra · full color detail · lossless encoding after color conversion · saved as MKV</p>}
      {(info?.audioTracks?.length ?? 0) > 1 && <p className="text-xs text-gray-400 mt-2">Audio tracks: {info!.audioTracks!.join(' · ')}</p>}
      {stats && <p className="mt-3 text-lg tabular-nums">{Math.round(stats.fps)} fps encoded · {(stats.bytes / 1_000_000).toFixed(0)} MB</p>}
      {stats?.pacing && <p className="text-xs text-gray-400 mt-2 tabular-nums">Encoded frame gaps: 95% ≤ {stats.pacing.p95GapMs} ms · longest {Math.round(stats.pacing.maxGapMs)} ms · {stats.pacing.gapsOver100ms} over 100 ms</p>}
      {stats?.warning && <p className="text-yellow-300 text-sm mt-3 max-w-lg text-center">{stats.warning}</p>}
      {info?.engine === 'browser' && <p className="text-xs text-gray-500 mt-3">Capture reports {info.captureFps?.toFixed(1)} fps; actual encoded delivery may be lower.</p>}
      <div className="flex gap-3 mt-8">
        <button className={buttonStyle} onClick={() => { void handlePause() }} disabled={!!busy}>{isPaused ? 'Resume' : 'Pause'}</button>
        <button className="clickable rounded-lg bg-red-600 px-6 py-2 text-sm disabled:opacity-40" onClick={() => { void handleStop() }} disabled={!!busy}>Stop and save</button>
      </div>
      <p className="text-xs text-gray-500 mt-6">{[keys.stop && `${hotkeyLabel(keys.stop)}: stop`, keys.record && `${hotkeyLabel(keys.record)}: stop`,
        keys.pause && `${hotkeyLabel(keys.pause)}: pause/resume`].filter((v, i, all) => v && all.indexOf(v) === i).join(' · ')}</p>
    </main> : view === 'record' ? <main className="px-6 pb-6">
      <div className="mb-5 flex flex-wrap gap-2 text-xs text-gray-400">
        <span className="bg-surface px-3 py-2 rounded-lg">{settings.qualityPreset.toUpperCase()} · {settings.frameRate === 'display' ? 'Display refresh' : `${settings.frameRate} fps`} · {settings.nativeCodec === 'hevc' ? 'HEVC' : 'H.264'}</span>
        <span className="bg-surface px-3 py-2 rounded-lg">System audio {settings.systemAudio ? 'on' : 'off'} · Mic {settings.micEnabled ? (settings.systemAudio && settings.micTrack === 'separate' ? 'on, own track' : 'on') : 'off'}</span>
        {keys.record && <span className="bg-surface px-3 py-2 rounded-lg">{hotkeyLabel(keys.record)} records {settings.lastSource ? settings.lastSource.name : 'the last source'}</span>}
        {capabilities && settings.recordingEngine !== 'browser' && <span className={`px-3 py-2 rounded-lg ${readyAdapters.length ? 'bg-surface' : 'bg-yellow-500/10 text-yellow-300'}`}>
          {readyAdapters.length ? `GPU capture ready on ${readyAdapters.map(a => `${a.name} (${encoderLabels[(a.encoders[settings.nativeCodec] ?? a.encoders.h264 ?? a.encoders.hevc)!]})`).join(', ')}`
            : capabilities.reason ?? 'GPU capture is not available on this computer yet'}</span>}
      </div>
      {settings.qualityPreset === 'ultra' && <p className="mb-5 text-sm text-gray-300">For smooth high-refresh gameplay, choose a GPU screen. Ultra keeps its full resolution and color detail. Window capture can deliver much lower frame rates.</p>}
      {[{ name: 'Screens', items: sources.filter(s => s.id.startsWith('screen:')) },
        { name: 'Windows', items: sources.filter(s => !s.id.startsWith('screen:')) }].map(group => group.items.length > 0 && <section key={group.name} className="mb-6">
        <h2 className="text-sm text-gray-300 mb-3">{group.name}{group.name === 'Screens' ? ' · recommended for games; records everything visible' : ' · records only the selected window'}</h2>
        <div className={`grid ${{ 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[settings.columnCount] || 'grid-cols-2'} gap-4`}>
        {group.items.map(source => {
          const support = settings.recordingEngine !== 'browser' && source.nativeDisplay ? gpuSupport(source.nativeDisplay, settings) : null
          const native = !!support?.ok
          const recommended = settings.recordingEngine !== 'browser' && sources.find(s => s.id === source.recommendedScreenId)
          const recommendedSupport = recommended && recommended.nativeDisplay ? gpuSupport(recommended.nativeDisplay, settings) : null
          const label = support ? (support.ok ? `GPU capture · ${encoderLabels[support.family]}` : 'GPU capture unavailable')
            : settings.recordingEngine === 'auto' && source.gpuUnavailableReason ? 'GPU capture unavailable' : 'Browser capture'
          const disabled = !!busy || !loaded || (settings.recordingEngine === 'native' && !native && !source.id.startsWith('window:'))
          return <div key={source.id} className="bg-surface rounded-lg overflow-hidden">
            <button onClick={() => { void handleStart(source) }} disabled={disabled}
              title={support && !support.ok ? support.reason : undefined}
            className="clickable group relative w-full aspect-video rounded-lg overflow-hidden border border-transparent hover:border-primary/50 text-left disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <img src={source.thumbnail} alt="" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/20 to-transparent p-3 flex flex-col justify-end">
              <span className="text-sm truncate">{source.name}</span>
              <span className={`text-xs mt-1 tabular-nums ${native ? 'text-primary' : 'text-gray-400'}`}>
                {label}{source.width ? ` · ${source.width}×${source.height}` : ''} · {requestedFps(settings.frameRate, source.refreshRate)} fps target
              </span>
              {source.nativeDisplay?.hdr && <span className="text-xs text-yellow-300 mt-0.5">HDR is on: GPU capture records an SDR conversion</span>}
            </div>
            </button>
            {native && <div className="flex divide-x divide-gray-800 border-t border-gray-800">
              <button className={`${secondaryAction} text-gray-300`} disabled={!!busy} onClick={() => { void pickRegion(source, 'record') }}
                title="Drag a rectangle or click a window; recorded on the GPU at full rate">Record an area…</button>
              <button className={`${secondaryAction} text-secondary`} disabled={!!busy || !!replay}
                onClick={() => { void armReplay(source) }} title={`Keeps the last ${formatSeconds(settings.replaySeconds)} ready to save`}>
                {replay?.source.id === source.id && !replay.source.region ? 'Replay on' : 'Instant replay'}</button>
            </div>}
            {recommended && recommendedSupport?.ok && <button className={`${secondaryAction} w-full text-primary border-t border-gray-800`} disabled={!!busy}
              title="Records the window's screen area on the GPU at full rate. Windows on top of it appear, and the area is fixed when recording starts."
              onClick={() => { void handleStart(source, { windowArea: true }) }}>Record this window's area on the GPU · {requestedFps(settings.frameRate, recommended.refreshRate)} fps</button>}
            {recommended && recommendedSupport?.ok && <button className={`${secondaryAction} w-full text-gray-400 border-t border-gray-800`} disabled={!!busy}
              onClick={() => { void handleStart(recommended) }}>Record entire {recommended.name} instead</button>}
          </div>
        })}
        </div>
      </section>)}
    </main> : null}
    <RecordingsPanel visible={view === 'recordings' && !isRecording} highlight={highlight} busy={!!job || !!busy}
      outputFolder={settings.outputFolder} onError={text => setError(text)} onRecord={() => setView('record')}
      onTrim={(entry, details) => setTrimming({ entry, details })} />
    {trimming && <TrimEditor entry={trimming.entry} details={trimming.details} onClose={() => setTrimming(null)}
      onError={text => setError(text)} onSaved={output => { setTrimming(null); setHighlight(output) }} />}
    <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} settings={settings} onSave={changes => { void saveSettings(changes) }} />
  </div>
}

export default MainApp
