import { useEffect, useMemo, useRef, useState } from 'react'
import { LibraryEntry, MediaDetails } from './recording'
import { formatBytes } from './RecordingsPanel'

const mediaUrl = (file: string) => `sleekrec-media://recording/${encodeURIComponent(file)}`

function clock(seconds: number): string {
  const s = Math.max(0, seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`
}

/**
 * In and out points over a preview. Fast mode cuts on the keyframe at or before the in
 * point, so the handle snaps there and the saved trim starts exactly where it shows.
 * Chromium cannot decode 4:4:4 H.264 (Ultra), so those masters scrub through decoded frames.
 */
export function TrimEditor({ entry, details, onClose, onSaved, onError }: {
  entry: LibraryEntry
  details?: MediaDetails
  onClose: () => void
  onSaved: (output: string) => void
  onError: (message: string) => void
}) {
  const [info, setInfo] = useState<MediaDetails | undefined>(details)
  const [keyframes, setKeyframes] = useState<number[] | null>(null)
  const [mode, setMode] = useState<'fast' | 'exact'>('fast')
  const [range, setRange] = useState<[number, number] | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playable, setPlayable] = useState(true)
  const [frame, setFrame] = useState<string>()
  const [saving, setSaving] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<'in' | 'out' | 'head' | null>(null)
  const duration = info?.seconds || entry.seconds || 0

  useEffect(() => {
    if (!info) window.electronAPI.mediaDetails(entry.path).then(setInfo).catch(error => onError(String(error)))
    window.electronAPI.mediaKeyframes(entry.path).then(setKeyframes).catch(() => setKeyframes([]))
  }, [entry.path])
  useEffect(() => { if (duration && !range) setRange([0, duration]) }, [duration])
  useEffect(() => { if (info?.pixelFormat?.startsWith('yuv444')) setPlayable(false) }, [info])

  // Scrubbing an unplayable master decodes the nearest keyframe, debounced while dragging.
  useEffect(() => {
    if (playable) return
    const timer = setTimeout(() => {
      window.electronAPI.mediaFrame(entry.path, time, 960).then(setFrame).catch(() => {})
    }, 120)
    return () => clearTimeout(timer)
  }, [playable, time])

  const snappedIn = useMemo(() => {
    if (!range) return 0
    if (mode === 'exact' || !keyframes?.length) return range[0]
    return [...keyframes].reverse().find(t => t <= range[0] + 0.001) ?? 0
  }, [range, keyframes, mode])

  const seek = (seconds: number) => {
    const t = Math.min(Math.max(0, seconds), duration)
    setTime(t)
    if (videoRef.current && playable) videoRef.current.currentTime = t
  }
  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration
  }
  const move = (clientX: number) => {
    if (!range || !drag.current) return
    const t = timeAt(clientX)
    if (drag.current === 'in') { setRange([Math.min(t, range[1] - 0.1), range[1]]); seek(Math.min(t, range[1] - 0.1)) }
    else if (drag.current === 'out') { setRange([range[0], Math.max(t, range[0] + 0.1)]); seek(Math.max(t, range[0] + 0.1)) }
    else seek(t)
  }
  const togglePlay = () => {
    const video = videoRef.current
    if (!video || !playable || !range) return
    if (video.paused) {
      if (video.currentTime >= range[1] - 0.05 || video.currentTime < snappedIn) video.currentTime = snappedIn
      void video.play()
    } else video.pause()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!range || saving) return
      const step = event.shiftKey ? 1 : 1 / 30
      if (event.key === 'Escape') onClose()
      else if (event.key === ' ') { event.preventDefault(); togglePlay() }
      else if (event.key.toLowerCase() === 'i') setRange([Math.min(time, range[1] - 0.1), range[1]])
      else if (event.key.toLowerCase() === 'o') setRange([range[0], Math.max(time, range[0] + 0.1)])
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(time - step) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(time + step) }
      else return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [range, time, playable, saving, snappedIn])

  const save = () => {
    if (!range) return
    setSaving(true)
    window.electronAPI.trimRecording(entry.path, range[0], range[1], mode)
      .then(output => onSaved(output))
      .catch(error => { onError(String(error)); setSaving(false) })
  }

  const pct = (t: number) => `${duration ? t / duration * 100 : 0}%`
  const ticks = keyframes && mode === 'fast' && keyframes.length <= 600 ? keyframes : []
  const selection = range ? range[1] - (mode === 'fast' ? snappedIn : range[0]) : 0
  // A fast cut copies packets, so its size scales with the share of the recording kept.
  const estimate = duration && mode === 'fast' ? entry.bytes * selection / duration : 0

  return <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6" onClick={() => { if (!saving) onClose() }}>
    <div role="dialog" aria-label="Trim recording" className="bg-surface border border-gray-700 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl"
      onClick={event => event.stopPropagation()}>
      <div className="px-5 pt-4 pb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Trim</h2>
        <span className="text-xs text-gray-500 truncate" title={entry.name}>{entry.name}</span>
      </div>
      <div className="px-5 overflow-y-auto">
        {/* Capped height keeps the timeline and cut options on screen in a 600 px window. */}
        <div className="relative h-[min(42vh,calc((100vw-6rem)*9/16))] bg-black rounded-lg overflow-hidden">
          {playable ? <video ref={videoRef} src={mediaUrl(entry.path)} className="w-full h-full object-contain" preload="auto"
            onError={() => { setPlayable(false); setPlaying(false) }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={event => {
              const t = event.currentTarget.currentTime
              if (drag.current) return
              setTime(t)
              if (range && t >= range[1]) event.currentTarget.pause()
            }} onClick={togglePlay} />
            : frame ? <img src={frame} alt="" className="w-full h-full object-contain" />
              : <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">Decoding preview…</div>}
          {!playable && <span className="absolute top-2 left-2 rounded bg-black/70 px-2 py-0.5 text-xs text-gray-300">
            Preview shows the nearest keyframe; this format does not play in the app</span>}
        </div>

        <div className="mt-4 select-none">
          <div ref={trackRef} className="relative h-12 rounded-md bg-gray-800 cursor-pointer touch-none"
            onPointerDown={event => {
              const target = (event.target as HTMLElement).dataset.handle as 'in' | 'out' | undefined
              drag.current = target ?? 'head'
              event.currentTarget.setPointerCapture(event.pointerId)
              move(event.clientX)
            }}
            onPointerMove={event => move(event.clientX)}
            onPointerUp={() => { drag.current = null }}>
            {ticks.map(t => <span key={t} className="absolute top-0 h-2 w-px bg-gray-600" style={{ left: pct(t) }} />)}
            {range && <>
              {mode === 'fast' && snappedIn < range[0] && <div className="absolute inset-y-0 bg-primary/10 border-l border-dashed border-primary/60"
                style={{ left: pct(snappedIn), width: `calc(${pct(range[0])} - ${pct(snappedIn)})` }} />}
              <div className="absolute inset-y-0 bg-primary/25 border-y-2 border-primary" style={{ left: pct(range[0]), right: `calc(100% - ${pct(range[1])})` }} />
              {(['in', 'out'] as const).map((handle, i) => <div key={handle} data-handle={handle} role="slider" tabIndex={0}
                aria-label={handle === 'in' ? 'In point' : 'Out point'} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={range[i]}
                className="absolute -top-1 -bottom-1 w-3 -ml-1.5 rounded bg-primary cursor-ew-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                style={{ left: pct(range[i]) }} />)}
            </>}
            <div className="absolute -top-2 -bottom-2 w-0.5 bg-white pointer-events-none" style={{ left: pct(time) }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400 tabular-nums">
            <span>In {clock(mode === 'fast' ? snappedIn : range?.[0] ?? 0)}</span>
            <span className="text-gray-200">{clock(time)} / {clock(duration)}</span>
            <span>Out {clock(range?.[1] ?? 0)}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="clickable rounded-lg bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40" disabled={!playable} onClick={togglePlay}>
            {playing ? 'Pause' : 'Play selection'}</button>
          <button className="clickable rounded-lg bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700" onClick={() => range && setRange([Math.min(time, range[1] - 0.1), range[1]])}>Set in · I</button>
          <button className="clickable rounded-lg bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700" onClick={() => range && setRange([range[0], Math.max(time, range[0] + 0.1)])}>Set out · O</button>
          <span className="text-xs text-gray-500">Space plays · arrows step a frame, Shift a second</span>
        </div>

        <fieldset className="mt-4 grid sm:grid-cols-2 gap-2">
          <legend className="sr-only">Cut mode</legend>
          {([['fast', 'Fast · original quality', 'Instant stream copy. Starts on the keyframe at or before the in point, at most about 2 s earlier.'],
            ['exact', 'Exact · re-encoded', 'Starts on the exact frame. Re-encodes to compatible H.264 MP4 at high quality; takes longer.']] as const)
            .map(([value, label, detail]) => <label key={value} className={`cursor-pointer rounded-lg border p-3 text-sm ${mode === value ? 'border-primary bg-primary/10' : 'border-gray-700 hover:border-gray-600'}`}>
              <input type="radio" name="trim-mode" className="sr-only" checked={mode === value} onChange={() => setMode(value)} />
              <span className={mode === value ? 'text-primary' : 'text-gray-200'}>{label}</span>
              <span className="block text-xs text-gray-500 mt-1">{detail}</span>
            </label>)}
        </fieldset>
        {mode === 'fast' && keyframes === null && <p className="mt-2 text-xs text-gray-500">Finding keyframes…</p>}
      </div>
      <div className="flex items-center gap-3 px-5 py-4 mt-4 border-t border-gray-800">
        <span className="text-xs text-gray-400 tabular-nums mr-auto">
          Keeps {clock(selection)}{estimate ? ` · about ${formatBytes(estimate)}` : ''} · saved as a new file next to the original
        </span>
        <button className="rounded-lg bg-gray-700 hover:bg-gray-600 px-4 py-2 text-sm" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="rounded-lg bg-primary hover:bg-primary/80 text-black font-medium px-4 py-2 text-sm disabled:opacity-40"
          disabled={!range || saving || (mode === 'fast' && keyframes === null)} onClick={save}>{saving ? 'Saving…' : 'Save trim'}</button>
      </div>
    </div>
  </div>
}
