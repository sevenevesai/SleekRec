import { useState } from 'react'
import { CompressionOptions, CompressionQuality, NativeCodec, compressionFpsCaps, compressionHeights, fitTargetRangeMB,
  isFitTargetMB } from './recording'

const qualityLabels: Record<CompressionQuality, string> = { high: 'High · larger file', balanced: 'Balanced', small: 'Small · softer detail' }

/** Codec, quality, height cap and frame rate cap; used by the export menu and Settings. */
export function CompressionFields({ value, onChange, selectClass }: {
  value: CompressionOptions
  onChange: (value: CompressionOptions) => void
  selectClass: string
}) {
  const row = 'flex items-center justify-between gap-3 text-xs text-gray-400'
  const cap = (raw: string) => raw === 'source' ? 'source' as const : Number(raw)
  return <>
    <label className={row}>Codec
      <select value={value.codec} className={selectClass} onChange={e => onChange({ ...value, codec: e.target.value as NativeCodec })}>
        <option value="h264">H.264</option>
        <option value="hevc">HEVC · smaller</option>
      </select>
    </label>
    {value.codec === 'hevc' && <p className="text-[11px] text-gray-500">HEVC is less compatible: some browsers, chat apps and older
      editors cannot play it. Needs a GPU encoder.</p>}
    <label className={row}>Quality
      <select value={value.quality} className={selectClass} onChange={e => onChange({ ...value, quality: e.target.value as CompressionQuality })}>
        {(Object.keys(qualityLabels) as CompressionQuality[]).map(quality => <option key={quality} value={quality}>{qualityLabels[quality]}</option>)}
      </select>
    </label>
    <label className={row}>Height
      <select value={String(value.maxHeight)} className={selectClass}
        onChange={e => onChange({ ...value, maxHeight: cap(e.target.value) as CompressionOptions['maxHeight'] })}>
        {compressionHeights.map(height => <option key={height} value={String(height)}>{height === 'source' ? 'Keep source' : `At most ${height}p`}</option>)}
      </select>
    </label>
    <label className={row}>Frame rate
      <select value={String(value.maxFps)} className={selectClass}
        onChange={e => onChange({ ...value, maxFps: cap(e.target.value) as CompressionOptions['maxFps'] })}>
        {compressionFpsCaps.map(fps => <option key={fps} value={String(fps)}>{fps === 'source' ? 'Keep source' : `At most ${fps} fps`}</option>)}
      </select>
    </label>
  </>
}

/** A whole size in megabytes within `fitTargetRangeMB`; reports undefined while the text is not one. */
export function FitSizeInput({ initial, onChange, onEnter, className }: {
  initial?: number
  onChange: (mb: number | undefined) => void
  onEnter?: () => void
  className: string
}) {
  const [text, setText] = useState(initial ? String(initial) : '')
  const invalid = text !== '' && !isFitTargetMB(Number(text))
  return <span className="inline-flex flex-col">
    <span className="inline-flex items-center gap-1.5">
      <input type="number" inputMode="numeric" min={fitTargetRangeMB.min} max={fitTargetRangeMB.max} step={1} value={text}
        placeholder={`${fitTargetRangeMB.min}–${fitTargetRangeMB.max}`} aria-invalid={invalid} aria-label="Size in MB"
        className={`${className} ${invalid ? 'border-red-400/70' : ''}`}
        onChange={e => {
          setText(e.target.value)
          onChange(e.target.value !== '' && isFitTargetMB(Number(e.target.value)) ? Number(e.target.value) : undefined)
        }}
        onKeyDown={e => { if (e.key === 'Enter' && !invalid && text !== '') onEnter?.() }} />
      <span className="text-xs text-gray-500">MB</span>
    </span>
    {invalid && <span role="alert" className="mt-1 text-[11px] text-red-300">Whole MB from {fitTargetRangeMB.min} to {fitTargetRangeMB.max}</span>}
  </span>
}
