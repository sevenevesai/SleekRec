import { useCallback, useEffect, useRef, useState } from 'react'
import { ExportRequest, FitTargetMB, LibraryEntry, MediaDetails, fitTargetsMB } from './recording'
import { formatSeconds } from './SettingsModal'

const kindLabels: Partial<Record<LibraryEntry['kind'], string>> = { replay: 'Replay', trim: 'Trim', export: 'Export', unfinished: 'Unfinished' }

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

function recordedAt(entry: LibraryEntry): string {
  const stamp = /Recording_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(entry.name)
  const date = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : new Date(entry.modifiedMs)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Loads probe details and the thumbnail once the card scrolls into view. */
function useDetails(entry: LibraryEntry, ref: React.RefObject<HTMLElement>): { details?: MediaDetails; failed: boolean } {
  const [details, setDetails] = useState<MediaDetails>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (entry.kind === 'unfinished' || !ref.current) return
    let alive = true
    const observer = new IntersectionObserver(([visible]) => {
      if (!visible.isIntersecting) return
      observer.disconnect()
      window.electronAPI.mediaDetails(entry.path).then(result => { if (alive) setDetails(result) })
        .catch(() => { if (alive) setFailed(true) })
    }, { rootMargin: '200px' })
    observer.observe(ref.current)
    return () => { alive = false; observer.disconnect() }
  }, [entry.path, entry.bytes, entry.modifiedMs])
  return { details, failed }
}

const actionStyle = 'clickable rounded-md px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40'

const icons = {
  copy: 'M8 8h11v11H8zM5 16V5h11',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3',
}

function IconButton({ label, path, onClick }: { label: string; path: string; onClick: () => void }) {
  return <button className={`${actionStyle} text-gray-400 px-1.5`} onClick={onClick} title={label} aria-label={label}>
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
  </button>
}

function ExportMenu({ onExport, disabled, container }: { onExport: (request: ExportRequest) => void; disabled: boolean; container: string }) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [open])
  const choose = (request: ExportRequest) => { setOpen(false); onExport(request) }
  return <div ref={ref} className="relative">
    <button className={actionStyle} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => {
      // Open upward only when it clears the sticky header; downward the page scrolls to it.
      const rect = ref.current?.getBoundingClientRect()
      setUp(!!rect && rect.bottom + 340 > innerHeight && rect.top - 340 > 100)
      setOpen(!open)
    }}>Export ▾</button>
    {open && <div role="menu" className={`absolute left-0 z-40 w-60 rounded-lg border border-gray-700 bg-[#262626] py-1 shadow-xl ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
      <p className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wider text-gray-500">Fit under</p>
      {fitTargetsMB.map((mb: FitTargetMB) => <button key={mb} role="menuitem" onClick={() => choose({ mode: 'fit', targetMB: mb })}
        className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-primary/15 flex justify-between">
        <span className="tabular-nums">{mb} MB</span><span className="text-xs text-gray-500">{mb === 10 ? 'Discord free' : mb === 25 ? 'email' : mb === 500 ? 'Discord Nitro' : ''}</span>
      </button>)}
      <div className="my-1 border-t border-gray-700" />
      {container !== 'webm' && <button role="menuitem" onClick={() => choose({ mode: 'copy' })} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-primary/15">
        MP4, same video <span className="block text-xs text-gray-500">No re-encode; keeps every audio track</span></button>}
      <button role="menuitem" onClick={() => choose({ mode: 'small' })} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-primary/15">
        Compatible H.264 MP4 <span className="block text-xs text-gray-500">Same size and frame rate, plays anywhere</span></button>
    </div>}
  </div>
}

function RecordingCard({ entry, highlighted, busy, onTrim, onError, onExport, onRecover }: {
  entry: LibraryEntry
  highlighted: boolean
  busy: boolean
  onTrim: (entry: LibraryEntry, details?: MediaDetails) => void
  onError: (message: string) => void
  onExport: (entry: LibraryEntry, request: ExportRequest) => void
  onRecover: (entry: LibraryEntry) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { details, failed } = useDetails(entry, ref)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { if (highlighted) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [highlighted])
  const act = (action: 'open' | 'reveal' | 'copy' | 'trash') => {
    window.electronAPI.recordingAction(entry.path, action)
      .then(() => { if (action === 'copy') window.electronAPI.toast('Copied. Paste it into a chat or a folder.') })
      .catch(error => onError(String(error)))
  }
  const seconds = details?.seconds || entry.seconds
  const width = details?.width || entry.width
  const height = details?.height || entry.height
  const unfinished = entry.kind === 'unfinished'
  // Derived files keep their operation (trim range, fit target) on a line of its own.
  const derived = !!entry.derivedFrom
  const meta = [width && height ? `${width}×${height}` : '', entry.fps ? `${entry.fps.toFixed(entry.fps < 100 ? 1 : 0)} fps` : '',
    formatBytes(entry.bytes), derived ? '' : entry.codec || details?.codec?.toUpperCase() || ''].filter(Boolean)
  return <div ref={ref} draggable={!unfinished}
    onDragStart={event => { event.preventDefault(); window.electronAPI.startDrag(entry.path) }}
    className={`group bg-surface rounded-lg border transition-colors ${highlighted ? 'border-primary' : 'border-transparent hover:border-gray-700'}`}>
    <button className="clickable relative block w-full aspect-video bg-black/40 rounded-t-lg overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      disabled={unfinished} onClick={() => act('open')} title={unfinished ? undefined : 'Play'}>
      {details?.thumbnail ? <img src={details.thumbnail} alt="" className="w-full h-full object-cover" />
        : <div className={`w-full h-full ${failed || unfinished ? '' : 'animate-pulse bg-gray-800/60'} flex items-center justify-center text-xs text-gray-500`}>
          {entry.savedAs ? 'Leftover capture parts' : unfinished ? `${entry.parts ? `${entry.parts} part${entry.parts > 1 ? 's' : ''} · ` : ''}not finalized` : failed ? 'No preview' : ''}</div>}
      {kindLabels[entry.kind] && <span className={`absolute top-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        entry.kind === 'replay' ? 'bg-secondary/15 text-secondary' : unfinished ? 'bg-yellow-500/15 text-yellow-300' : 'bg-black/60 text-gray-200'}`}>{kindLabels[entry.kind]}</span>}
      {!!seconds && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">{formatSeconds(seconds)}</span>}
    </button>
    <div className="p-3 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-white truncate">{recordedAt(entry)}</span>
        {entry.engine && <span className="shrink-0 text-[11px] text-gray-500">{entry.engine === 'native' ? 'GPU' : 'Browser'}</span>}
      </div>
      <p className="text-xs text-gray-400 tabular-nums truncate" title={entry.name}>{meta.join(' · ')}</p>
      {derived && entry.codec && <p className="text-xs text-gray-400 truncate" title={entry.codec}>{entry.codec}</p>}
      {derived && <p className="text-xs text-gray-500 truncate" title={entry.derivedFrom}>From {entry.derivedFrom}</p>}
      {!!entry.gapsOver100ms && <p className="text-xs text-yellow-300/90">{entry.gapsOver100ms} frame gaps over 100 ms</p>}
      {(entry.audioTracks?.length ?? 0) > 1 && <p className="text-xs text-gray-500">{entry.audioTracks!.length} audio tracks</p>}
      {entry.warning && <p className="text-xs text-yellow-300/90">{entry.warning}</p>}
      {entry.savedAs && <p className="text-xs text-gray-400">Saved as {entry.savedAs}; these parts could not be deleted then and are safe to delete.</p>}
      <div className="flex items-center gap-0.5 pt-1 -ml-2">
        {unfinished
          ? !entry.savedAs && <button className={actionStyle} disabled={busy} onClick={() => onRecover(entry)} title="Join the parts into a playable MKV; the parts go to the recycle bin">Recover</button>
          : <>
            <button className={actionStyle} onClick={() => act('open')}>Play</button>
            <button className={actionStyle} disabled={busy} onClick={() => onTrim(entry, details)}>Trim</button>
            <ExportMenu disabled={busy} container={entry.container} onExport={request => onExport(entry, request)} />
          </>}
        <span className="flex-1" />
        {!unfinished && <IconButton label="Copy the file to paste into Discord or a folder" onClick={() => act('copy')} path={icons.copy} />}
        <IconButton label="Show in folder" onClick={() => act('reveal')} path={icons.folder} />
        {confirmDelete
          ? <button className={`${actionStyle} text-red-300 hover:text-red-200`} onBlur={() => setConfirmDelete(false)} autoFocus
            onClick={() => act('trash')}>Move to bin?</button>
          : <IconButton label="Delete (moves to the recycle bin)" onClick={() => setConfirmDelete(true)} path={icons.trash} />}
      </div>
    </div>
  </div>
}

export function RecordingsPanel({ visible, highlight, busy, onTrim, onError, onRecord, outputFolder }: {
  visible: boolean
  highlight: string | null
  busy: boolean
  onTrim: (entry: LibraryEntry, details?: MediaDetails) => void
  onError: (message: string) => void
  onRecord: () => void
  outputFolder: string
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [stale, setStale] = useState(false)
  const refresh = useCallback(() => {
    setStale(true)
    window.electronAPI.listRecordings()
      .then(list => { setEntries(list); setLoadError('') })
      .catch(error => setLoadError(String(error)))
      .finally(() => setStale(false))
  }, [])
  useEffect(() => { if (visible) refresh() }, [visible, outputFolder, refresh])
  useEffect(() => window.electronAPI.onLibraryChanged(() => { if (visible) refresh() }), [visible, refresh])
  useEffect(() => {
    if (!visible) return
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [visible, refresh])

  const exportEntry = (entry: LibraryEntry | null, request: ExportRequest) => {
    window.electronAPI.exportRecording(entry?.path ?? null, request)
      .then(output => { if (output) window.electronAPI.toast(`Exported ${output.split(/[\\/]/).pop()}`) })
      .catch(error => onError(String(error)))
  }
  const recover = (entry: LibraryEntry) => {
    window.electronAPI.recoverRecording(entry.path)
      .then(saved => window.electronAPI.toast(`Recovered ${saved.path.split(/[\\/]/).pop()}`))
      .catch(error => onError(`Recovery failed: ${String(error)}. The parts are still in the output folder.`))
  }

  if (!visible) return null
  const total = entries?.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0
  return <main className="px-6 pb-6">
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <p className="text-xs text-gray-500 mr-auto tabular-nums">
        {entries ? `${entries.length} item${entries.length === 1 ? '' : 's'} · ${formatBytes(total)}` : 'Loading…'}
        <span className="ml-2 text-gray-600" title={outputFolder}>{outputFolder}</span>
        {stale && entries && <span className="ml-2 text-gray-600">refreshing…</span>}
      </p>
      <button className={actionStyle} onClick={refresh}>Refresh</button>
      <button className={actionStyle} onClick={() => { void window.electronAPI.openOutputFolder().catch(error => onError(String(error))) }}>Open folder</button>
      <button className={actionStyle} disabled={busy} onClick={() => exportEntry(null, { mode: 'small' })} title="Make a compatible MP4 from a file anywhere on disk">Convert a file…</button>
    </div>
    {loadError && <div role="alert" className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-200 flex items-center gap-3">
      <span className="flex-1">Could not list recordings: {loadError}</span>
      <button className={actionStyle} onClick={refresh}>Retry</button>
    </div>}
    {!entries && !loadError && <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
      {[0, 1, 2].map(i => <div key={i} className="bg-surface rounded-lg overflow-hidden"><div className="aspect-video animate-pulse bg-gray-800/60" /><div className="h-24" /></div>)}
    </div>}
    {entries?.length === 0 && <div className="py-16 text-center">
      <p className="text-gray-300">No recordings in this folder yet.</p>
      <p className="text-sm text-gray-500 mt-1">Recordings, replays, trims and exports appear here as soon as they are saved.</p>
      <button className="clickable mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-black hover:bg-primary/80" onClick={onRecord}>Choose something to record</button>
    </div>}
    {!!entries?.length && <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
      {entries.map(entry => <RecordingCard key={entry.path} entry={entry} highlighted={entry.path === highlight} busy={busy}
        onTrim={onTrim} onError={onError} onExport={exportEntry} onRecover={recover} />)}
    </div>}
    {!!entries?.length && <p className="mt-4 text-xs text-gray-600">Drag a card into Discord, an editor or a folder to share the file.</p>}
  </main>
}
