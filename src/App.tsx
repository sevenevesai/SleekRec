import { useState, useEffect, useRef, useCallback } from 'react'

type Source = {
  id: string
  name: string
  thumbnail: string
}

// Overlay Component - shown in a separate always-on-top window
function RecordingOverlay() {
  const [timer, setTimer] = useState(0)
  const [isPaused, setIsPaused] = useState(false)

  useEffect(() => {
    // Listen for timer updates from main window
    const cleanup = window.electronAPI.onTimerUpdate((data) => {
      setTimer(data.timer)
      setIsPaused(data.isPaused)
    })
    return cleanup
  }, [])

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handlePause = () => {
    window.electronAPI.overlayPause()
  }

  const handleStop = () => {
    window.electronAPI.overlayStop()
  }

  return (
    <div className="h-screen w-full flex items-center justify-between px-4 bg-surface/95 rounded-xl border border-gray-700/50" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Timer */}
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`} />
        <span className="text-white font-mono text-xl tracking-wider">{formatTime(timer)}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Pause/Resume */}
        <button
          onClick={handlePause}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-700/50 hover:bg-gray-600/50 transition-colors"
          title={isPaused ? 'Resume' : 'Pause'}
        >
          {isPaused ? (
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
            </svg>
          )}
        </button>

        {/* Stop */}
        <button
          onClick={handleStop}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors"
          title="Stop Recording"
        >
          <div className="w-4 h-4 bg-red-500 rounded-sm" />
        </button>
      </div>
    </div>
  )
}

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

  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  useEffect(() => {
    if (!isOpen) return
    window.electronAPI.getQualityPresets().then(setPresets)
    refreshMicDevices()
  }, [isOpen])

  const refreshMicDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
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
    { value: 'ultra', label: 'Ultra', desc: 'Maximum quality, biggest files' }
  ]

  const currentPreset = presets?.[localSettings.qualityPreset]

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface border border-gray-700 rounded-xl w-full max-w-md p-6 shadow-2xl"
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
              ~{currentPreset.estimateMbPerMin} MB/min &bull; CRF {currentPreset.crf}
            </p>
          )}
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
              <div>
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

// Main App Component
function MainApp() {
  const [sources, setSources] = useState<Source[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [timer, setTimer] = useState(0)
  const [selectedSourceName, setSelectedSourceName] = useState('')
  const [settings, setSettings] = useState<AppSettings>({
    outputFolder: '',
    qualityPreset: 'medium',
    columnCount: 2,
    micEnabled: false,
    micDeviceId: null,
    micVolume: 0.8
  })
  const [showSettings, setShowSettings] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sourceRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSourcesRef = useRef<string>('')
  const isPausedRef = useRef(false)
  const timerRef = useRef(0)

  useEffect(() => {
    refreshSources()
    loadSettings()

    // Auto-refresh sources every 3 seconds (lightweight polling)
    sourceRefreshRef.current = setInterval(() => {
      if (!isRecording && !isProcessing) {
        refreshSourcesSilent()
      }
    }, 3000)

    return () => {
      if (sourceRefreshRef.current) clearInterval(sourceRefreshRef.current)
    }
  }, [isRecording, isProcessing])

  // Listen for commands from overlay
  useEffect(() => {
    const cleanupPause = window.electronAPI.onPauseRecording(() => {
      handlePauseInternal()
    })
    const cleanupStop = window.electronAPI.onStopRecording(() => {
      handleStopInternal()
    })
    return () => {
      cleanupPause()
      cleanupStop()
    }
  }, [])


  const loadSettings = async () => {
    const s = await window.electronAPI.getSettings()
    setSettings(s)
  }

  const refreshSources = async () => {
    const _sources = await window.electronAPI.getSources()
    setSources(_sources)
    lastSourcesRef.current = JSON.stringify(_sources.map(s => s.id))
  }

  // Silent refresh - only update if sources changed
  const refreshSourcesSilent = async () => {
    const _sources = await window.electronAPI.getSources()
    const newSourceIds = JSON.stringify(_sources.map(s => s.id))
    if (newSourceIds !== lastSourcesRef.current) {
      setSources(_sources)
      lastSourcesRef.current = newSourceIds
    }
  }

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleStart = async (source: Source) => {
    try {
      // Get quality preset for bitrate
      const presets = await window.electronAPI.getQualityPresets()
      const preset = presets[settings.qualityPreset]

      const desktopStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop'
          }
        } as any,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
            maxFrameRate: 30
          }
        } as any
      })

      let recordingStream: MediaStream

      if (settings.micEnabled) {
        try {
          const micConstraints: MediaTrackConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
          if (settings.micDeviceId) {
            micConstraints.deviceId = { exact: settings.micDeviceId }
          }
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints })
          micStreamRef.current = micStream

          const ctx = new AudioContext()
          audioContextRef.current = ctx

          const desktopSource = ctx.createMediaStreamSource(desktopStream)
          const micSource = ctx.createMediaStreamSource(micStream)
          const micGain = ctx.createGain()
          micGain.gain.value = settings.micVolume

          const dest = ctx.createMediaStreamDestination()
          desktopSource.connect(dest)
          micSource.connect(micGain)
          micGain.connect(dest)

          recordingStream = new MediaStream([
            ...desktopStream.getVideoTracks(),
            ...dest.stream.getAudioTracks()
          ])
        } catch (micErr) {
          console.warn('Mic capture failed, recording without mic:', micErr)
          recordingStream = desktopStream
        }
      } else {
        recordingStream = desktopStream
      }

      window.electronAPI.startSave()

      const recorder = new MediaRecorder(recordingStream, {
        mimeType: 'video/webm; codecs=vp9',
        videoBitsPerSecond: preset.videoBitrate
      })

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          e.data.arrayBuffer().then(buffer => {
            window.electronAPI.saveChunk(buffer)
          })
        }
      }

      recorder.start(1000)

      mediaRecorderRef.current = recorder
      streamRef.current = desktopStream
      isPausedRef.current = false
      timerRef.current = 0

      setIsRecording(true)
      setIsPaused(false)
      setSelectedSourceName(source.name)
      setTimer(0)

      // Start timer and sync with overlay
      intervalRef.current = setInterval(() => {
        if (!isPausedRef.current) {
          timerRef.current++
          setTimer(timerRef.current)
        }
        // Sync timer state to overlay window
        window.electronAPI.syncTimer({ timer: timerRef.current, isPaused: isPausedRef.current })
      }, 1000)

      // Initial sync
      window.electronAPI.syncTimer({ timer: 0, isPaused: false })

      // Show overlay and minimize main window
      window.electronAPI.showOverlay()

    } catch (err) {
      console.error("Error starting recording:", err)
    }
  }

  // Internal handlers that work with refs (for IPC callbacks)
  const handlePauseInternal = useCallback(() => {
    if (!mediaRecorderRef.current) return

    if (isPausedRef.current) {
      mediaRecorderRef.current.resume()
      isPausedRef.current = false
      setIsPaused(false)
    } else {
      mediaRecorderRef.current.pause()
      isPausedRef.current = true
      setIsPaused(true)
    }
    // Immediate sync
    window.electronAPI.syncTimer({ timer: timerRef.current, isPaused: isPausedRef.current })
  }, [])

  const handleStopInternal = useCallback(async () => {
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === 'paused') {
        mediaRecorderRef.current.resume()
      }
      mediaRecorderRef.current.stop()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop())
      micStreamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }

    isPausedRef.current = false
    timerRef.current = 0

    setIsRecording(false)
    setIsPaused(false)
    setIsProcessing(true)

    try {
      await window.electronAPI.stopSave()
    } catch (err) {
      console.error(err)
    } finally {
      setIsProcessing(false)
      setTimer(0)
      refreshSources()
    }
  }, [])

  // UI button handlers (call internal handlers)
  const handlePause = useCallback(() => {
    handlePauseInternal()
  }, [handlePauseInternal])

  const handleStop = useCallback(async () => {
    await handleStopInternal()
  }, [handleStopInternal])

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const updated = await window.electronAPI.saveSettings(newSettings)
    setSettings(updated)
  }

  if (isProcessing) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-white draggable">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-primary mb-4"></div>
        <h2 className="text-xl font-light tracking-wider">Processing MP4...</h2>
        <p className="text-gray-400 text-sm mt-2">Saving to {settings.outputFolder || 'Videos/SleekRecordings'}</p>
      </div>
    )
  }

  if (isRecording) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-white">
        <div className={`w-4 h-4 rounded-full mb-4 ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`} />
        <div className="text-6xl font-thin tracking-widest mb-8 font-mono">
          {formatTime(timer)}
        </div>
        <div className="mb-8 text-center">
          <p className="text-gray-400 text-sm uppercase tracking-widest mb-2">
            {isPaused ? 'Paused' : 'Recording'}
          </p>
          <h3 className="text-xl font-medium text-white max-w-md truncate">{selectedSourceName}</h3>
        </div>

        <div className="flex gap-4">
          {/* Pause/Resume */}
          <button
            onClick={handlePause}
            className="clickable group relative flex items-center justify-center w-16 h-16 bg-yellow-500/10 rounded-full hover:bg-yellow-500/20 transition-all duration-300 ring-1 ring-yellow-500/50 hover:ring-yellow-500"
          >
            {isPaused ? (
              <svg className="w-6 h-6 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
            ) : (
              <svg className="w-6 h-6 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
              </svg>
            )}
          </button>

          {/* Stop */}
          <button
            onClick={handleStop}
            className="clickable group relative flex items-center justify-center w-20 h-20 bg-red-500/10 rounded-full hover:bg-red-500/20 transition-all duration-300 ring-1 ring-red-500/50 hover:ring-red-500"
          >
            <div className="w-8 h-8 bg-red-500 rounded-sm group-hover:scale-90 transition-transform duration-200" />
          </button>
        </div>

        <p className="mt-6 text-xs text-gray-500">Use the overlay panel to control recording</p>
      </div>
    )
  }

  const gridCols = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4'
  }[settings.columnCount] || 'grid-cols-2'

  return (
    <div className="h-screen bg-background text-white flex flex-col overflow-y-auto">
      <header className="p-6 pb-4 flex justify-between items-center draggable shrink-0 sticky top-0 bg-background/80 backdrop-blur-md z-10">
        <div>
          <h1 className="text-2xl font-light tracking-wide">Sleek<span className="font-bold text-primary">Rec</span></h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Select source to record</p>
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={() => handleSaveSettings({ micEnabled: !settings.micEnabled })}
            className={`clickable p-2 rounded-lg transition-colors ${
              settings.micEnabled
                ? 'text-primary bg-primary/10 hover:bg-primary/20'
                : 'text-gray-400 hover:text-white hover:bg-surface'
            }`}
            title={settings.micEnabled ? 'Microphone on' : 'Microphone off'}
          >
            {settings.micEnabled ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
                <line x1="3" y1="3" x2="21" y2="21" strokeLinecap="round" strokeWidth={1.5} />
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="clickable p-2 text-gray-400 hover:text-white hover:bg-surface rounded-lg transition-colors"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={refreshSources}
            className="clickable px-4 py-2 text-xs font-medium bg-surface hover:bg-gray-800 rounded transition-colors"
          >
            REFRESH
          </button>
        </div>
      </header>

      <div className="flex-1 p-6 pt-0">
        <div className={`grid ${gridCols} gap-4 pb-4`}>
          {sources.map(source => (
            <button
              key={source.id}
              onClick={() => handleStart(source)}
              className="clickable group relative aspect-video bg-surface rounded-lg overflow-hidden border border-transparent hover:border-primary/50 transition-all duration-300 text-left focus:outline-none"
            >
              <img
                src={source.thumbnail}
                alt={source.name}
                className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-300"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent p-4 flex flex-col justify-end">
                <span className="text-xs font-medium text-gray-300 group-hover:text-white truncate block">
                  {source.name}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  )
}

// Router based on hash
function App() {
  const [isOverlay, setIsOverlay] = useState(window.location.hash === '#overlay')

  useEffect(() => {
    const handleHashChange = () => {
      setIsOverlay(window.location.hash === '#overlay')
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    // Set transparent background for overlay window
    if (isOverlay) {
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
    }
  }, [isOverlay])

  if (isOverlay) {
    return <RecordingOverlay />
  }

  return <MainApp />
}

export default App
