import { Menu, MenuItemConstructorOptions, NativeImage, Tray, nativeImage } from 'electron'

export type TrayMode = 'idle' | 'recording' | 'paused' | 'replay'

export interface TrayState {
  mode: TrayMode
  lastSourceName?: string
  replayAvailable: boolean
  labels: { record: string; stop: string; pause: string; replaySave: string }
}

export interface TrayActions {
  record: () => void
  stop: () => void
  pause: () => void
  replayToggle: () => void
  replaySave: () => void
  show: () => void
  showRecordings: () => void
  openFolder: () => void
  quit: () => void
}

// Drawn in code so the tray needs no image assets: an accent ring with a state dot. Pixels
// are premultiplied BGRA, Chromium's native bitmap layout on Windows, macOS and Linux.
const colors: Record<TrayMode, [number, number, number]> = {
  idle: [0xbb, 0x86, 0xfc], recording: [0xef, 0x44, 0x44], paused: [0xea, 0xb3, 0x08], replay: [0x03, 0xda, 0xc6],
}

function drawIcon(size: number, mode: TrayMode): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const ring = colors.idle
  const dot = colors[mode]
  const outer = size * 0.47
  const inner = size * 0.36
  const dotRadius = mode === 'idle' ? size * 0.16 : size * 0.26
  const cover = (distance: number, radius: number) => Math.max(0, Math.min(1, radius - distance + 0.5))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - center, y - center)
      let alpha = 0
      let rgb = ring
      const ringAlpha = cover(d, outer) * (1 - cover(d, inner))
      let dotAlpha = cover(d, dotRadius)
      if (mode === 'paused') {
        // Two bars instead of a dot.
        const bar = Math.abs(Math.abs(x - center) - size * 0.13) <= size * 0.07 && Math.abs(y - center) <= size * 0.2
        dotAlpha = bar ? 1 : 0
      }
      if (dotAlpha > 0) { rgb = dot; alpha = dotAlpha }
      else if (ringAlpha > 0) alpha = ringAlpha
      const i = (y * size + x) * 4
      pixels[i] = Math.round(rgb[2] * alpha)
      pixels[i + 1] = Math.round(rgb[1] * alpha)
      pixels[i + 2] = Math.round(rgb[0] * alpha)
      pixels[i + 3] = Math.round(255 * alpha)
    }
  }
  return pixels
}

function trayImage(mode: TrayMode): NativeImage {
  const image = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32]] as const) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: drawIcon(size, mode) })
  }
  return image
}

/** The idle mark at 32 px, used as the drag image when a recording is dragged out. */
export function appIcon(): NativeImage {
  return nativeImage.createFromBitmap(drawIcon(32, 'idle'), { width: 32, height: 32 })
}

export class AppTray {
  private tray: Tray
  private images = new Map<TrayMode, NativeImage>()
  private mode?: TrayMode

  constructor(private actions: TrayActions) {
    this.tray = new Tray(this.image('idle'))
    this.tray.on('click', () => actions.show())
  }

  private image(mode: TrayMode): NativeImage {
    if (!this.images.has(mode)) this.images.set(mode, trayImage(mode))
    return this.images.get(mode)!
  }

  update(state: TrayState): void {
    if (state.mode !== this.mode) {
      this.tray.setImage(this.image(state.mode))
      this.mode = state.mode
    }
    const active = state.mode === 'recording' || state.mode === 'paused'
    this.tray.setToolTip({ idle: 'SleekRec', recording: 'SleekRec · recording', paused: 'SleekRec · paused',
      replay: 'SleekRec · instant replay armed' }[state.mode])
    // Menu accelerators only label the items here; the global hotkeys are registered separately.
    const key = (accelerator: string) => accelerator || undefined
    const items: MenuItemConstructorOptions[] = [
      active
        ? { label: 'Stop and save', accelerator: key(state.labels.stop), click: this.actions.stop }
        : { label: state.lastSourceName ? `Record ${state.lastSourceName}` : 'Record…', accelerator: key(state.labels.record),
          click: this.actions.record },
      ...(active ? [{ label: state.mode === 'paused' ? 'Resume' : 'Pause', accelerator: key(state.labels.pause), click: this.actions.pause }] : []),
      { type: 'separator' },
      ...(state.mode === 'replay' ? [
        { label: 'Save replay', accelerator: key(state.labels.replaySave), click: this.actions.replaySave },
        { label: 'Turn off instant replay', click: this.actions.replayToggle },
      ] : [{ label: 'Turn on instant replay', enabled: state.replayAvailable && !active, click: this.actions.replayToggle }]),
      { type: 'separator' },
      { label: 'Show SleekRec', click: this.actions.show },
      { label: 'Recordings', click: this.actions.showRecordings },
      { label: 'Open recordings folder', click: this.actions.openFolder },
      { type: 'separator' },
      { label: 'Quit SleekRec', click: this.actions.quit },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  destroy(): void { this.tray.destroy() }
}
