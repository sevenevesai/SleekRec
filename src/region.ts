// Full-screen area picker over one display. Coordinates here are the window's CSS pixels
// (DIPs from the display's origin); main converts the result to physical pixels.
import './index.css'

type Rect = { x: number; y: number; width: number; height: number }

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const hint = document.getElementById('hint')!
const label = document.getElementById('label')!
const context = canvas.getContext('2d')!
const accent = '#bb86fc'

let windows: (Rect & { title: string })[] = []
let scale = 1
let hover = -1
let start: { x: number; y: number } | null = null
let drawn: Rect | null = null
let selected: { window?: number; rect?: Rect } | null = null

const normalize = (a: { x: number; y: number }, b: { x: number; y: number }): Rect =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
const contains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
const current = (): Rect | null => drawn ?? (selected?.rect ?? (selected?.window !== undefined ? windows[selected.window]
  : hover >= 0 ? windows[hover] : null))

function resize() {
  canvas.width = innerWidth * devicePixelRatio
  canvas.height = innerHeight * devicePixelRatio
  canvas.style.width = `${innerWidth}px`
  canvas.style.height = `${innerHeight}px`
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  draw()
}

function draw() {
  context.clearRect(0, 0, innerWidth, innerHeight)
  context.fillStyle = 'rgba(0, 0, 0, 0.45)'
  context.fillRect(0, 0, innerWidth, innerHeight)
  const rect = current()
  label.classList.toggle('hidden', !rect)
  if (!rect) return
  context.clearRect(rect.x, rect.y, rect.width, rect.height)
  context.strokeStyle = accent
  context.lineWidth = selected || drawn ? 2 : 1
  context.setLineDash(selected ? [] : [6, 4])
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)
  const title = !drawn && !selected?.rect ? windows[selected?.window ?? hover]?.title : undefined
  // Physical pixels, rounded down to even sizes as the recording will be.
  const size = `${Math.floor(rect.width * scale / 2) * 2} × ${Math.floor(rect.height * scale / 2) * 2}`
  label.textContent = `${title ? `${title.slice(0, 48)} · ` : ''}${size}${selected ? ' · Enter or click to record' : ''}`
  label.style.left = `${Math.min(rect.x, innerWidth - label.offsetWidth - 8)}px`
  label.style.top = `${rect.y > 32 ? rect.y - 28 : Math.min(rect.y + rect.height + 6, innerHeight - 28)}px`
}

function finish(result: { window?: number; rect?: Rect } | null) {
  window.electronAPI.regionDone(result)
}

canvas.addEventListener('pointerdown', event => {
  const rect = selected && current()
  if (rect && contains(rect, event.clientX, event.clientY) && event.button === 0) { finish(selected); return }
  if (event.button !== 0) return
  canvas.setPointerCapture(event.pointerId)
  start = { x: event.clientX, y: event.clientY }
  selected = null
  drawn = null
})
canvas.addEventListener('pointermove', event => {
  if (start) {
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) drawn = normalize(start, { x: event.clientX, y: event.clientY })
  } else {
    hover = windows.findIndex(w => contains(w, event.clientX, event.clientY))
  }
  draw()
})
canvas.addEventListener('pointerup', event => {
  if (!start) return
  start = null
  if (drawn && drawn.width >= 16 && drawn.height >= 16) selected = { rect: drawn }
  else {
    const index = windows.findIndex(w => contains(w, event.clientX, event.clientY))
    selected = index >= 0 ? { window: index } : null
  }
  drawn = null
  hint.textContent = selected ? 'Enter or click inside to record. Drag again to change it. Esc cancels.' : hint.textContent
  draw()
})
canvas.addEventListener('contextmenu', event => { event.preventDefault(); finish(null) })
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (selected) { selected = null; draw() } else finish(null)
  } else if (event.key === 'Enter' && selected) finish(selected)
})
window.addEventListener('resize', resize)

void window.electronAPI.regionInit().then(init => {
  if (!init) return
  windows = init.windows
  scale = init.scaleFactor
  resize()
})
resize()
