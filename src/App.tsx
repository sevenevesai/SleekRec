import { useState, useEffect, useRef } from 'react'

type Source = {
  id: string
  name: string
  thumbnail: string
}

function App() {
  const [sources, setSources] = useState<Source[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [timer, setTimer] = useState(0)
  const [selectedSourceName, setSelectedSourceName] = useState('')
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const intervalRef = useRef<any>(null)

  useEffect(() => {
    refreshSources()
  }, [])

  const refreshSources = async () => {
    const _sources = await window.electronAPI.getSources()
    setSources(_sources)
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleStart = async (source: Source) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop'
          }
        } as any, // TypeScript generic casting for electron-specific constraint
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

      // Tell main process to open file stream
      window.electronAPI.startSave()

      const recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm; codecs=vp9',
        videoBitsPerSecond: 2500000 // 2.5 Mbps capture limit (helps control source bloat)
      })

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          e.data.arrayBuffer().then(buffer => {
            window.electronAPI.saveChunk(buffer)
          })
        }
      }

      recorder.start(1000) // 1 second chunks
      
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      
      setIsRecording(true)
      setSelectedSourceName(source.name)
      
      // Timer
      setTimer(0)
      intervalRef.current = setInterval(() => {
        setTimer(t => t + 1)
      }, 1000)

      // Minimize to get out of the way
      window.electronAPI.minimize()

    } catch (err) {
      console.error("Error starting recording:", err)
    }
  }

  const handleStop = async () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }

    setIsRecording(false)
    setIsProcessing(true)

    try {
      await window.electronAPI.stopSave()
    } catch (err) {
      console.error(err)
    } finally {
      setIsProcessing(false)
      setTimer(0)
      refreshSources() // Refresh list for next time
    }
  }

  if (isProcessing) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-white draggable">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-primary mb-4"></div>
        <h2 className="text-xl font-light tracking-wider">Processing MP4...</h2>
        <p className="text-gray-400 text-sm mt-2">Saving to Videos/SleekRecordings</p>
      </div>
    )
  }

  if (isRecording) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-white">
        <div className="text-6xl font-thin tracking-widest mb-8 font-mono">
          {formatTime(timer)}
        </div>
        <div className="mb-8 text-center">
          <p className="text-gray-400 text-sm uppercase tracking-widest mb-2">Recording</p>
          <h3 className="text-xl font-medium text-white max-w-md truncate">{selectedSourceName}</h3>
        </div>
        
        <button 
          onClick={handleStop}
          className="clickable group relative flex items-center justify-center w-20 h-20 bg-red-500/10 rounded-full hover:bg-red-500/20 transition-all duration-300 ring-1 ring-red-500/50 hover:ring-red-500"
        >
          <div className="w-8 h-8 bg-red-500 rounded-sm group-hover:scale-90 transition-transform duration-200" />
        </button>
        <p className="mt-4 text-xs text-gray-500">Minimize this window to hide controls</p>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background text-white flex flex-col overflow-y-auto">
      <header className="p-6 pb-4 flex justify-between items-center draggable shrink-0 sticky top-0 bg-background/80 backdrop-blur-md z-10">
        <div>
          <h1 className="text-2xl font-light tracking-wide">Sleek<span className="font-bold text-primary">Rec</span></h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Select source to record</p>
        </div>
        <button 
          onClick={refreshSources}
          className="clickable px-4 py-2 text-xs font-medium bg-surface hover:bg-gray-800 rounded transition-colors"
        >
          REFRESH
        </button>
      </header>

      <div className="flex-1 p-6 pt-0">
        <div className="grid grid-cols-2 gap-4 pb-4">
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
    </div>
  )
}

export default App
