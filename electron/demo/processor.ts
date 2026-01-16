/**
 * Demo Mode Processor
 * Generates FFmpeg filter chains for zoom effects from recorded interaction events
 */

interface InteractionEvent {
  type: 'click' | 'focus' | 'idle-start' | 'idle-end'
  timestamp: number
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  meta?: {
    zoomLevel?: number
    duration?: number
    skip?: boolean
  }
}

interface DemoModeSettings {
  clickZoom: {
    enabled: boolean
    level: number
    easeIn: number
    easeOut: number
    holdDuration: number
  }
  cursor: {
    hide: boolean
    overlay: 'none' | 'dot' | 'pointer' | 'custom'
    smoothing: number
    clickEffect: 'none' | 'ripple' | 'pulse' | 'highlight'
    clickEffectSize: number
    clickEffectColor: string
  }
  transitions: {
    idleThreshold: number
    idleSpeedup: number
    fadeOnJump: boolean
  }
}

interface RecordingSession {
  video: string
  events: InteractionEvent[]
  cursorFrames: { timestamp: number; x: number; y: number; visible: boolean; clicking: boolean }[]
  duration: number
  resolution: { width: number; height: number }
  settings: DemoModeSettings
  createdAt: string
}

interface ZoomKeyframe {
  time: number      // seconds
  zoom: number      // 1.0 = 100%
  centerX: number   // 0-1 normalized
  centerY: number   // 0-1 normalized
}

/**
 * Generate zoom keyframes from click events
 */
export function generateZoomKeyframes(
  events: InteractionEvent[],
  settings: DemoModeSettings['clickZoom']
): ZoomKeyframe[] {
  if (!settings.enabled) return []

  const keyframes: ZoomKeyframe[] = []
  const clickEvents = events.filter(e => e.type === 'click' && !e.meta?.skip)

  for (const event of clickEvents) {
    const zoomLevel = event.meta?.zoomLevel ?? settings.level
    const holdDuration = event.meta?.duration ?? settings.holdDuration
    const t = event.timestamp / 1000 // convert to seconds

    // Start of zoom (at current zoom level, which is 1.0 or previous)
    keyframes.push({
      time: t,
      zoom: 1.0,
      centerX: event.x,
      centerY: event.y
    })

    // Fully zoomed in
    keyframes.push({
      time: t + settings.easeIn / 1000,
      zoom: zoomLevel,
      centerX: event.x,
      centerY: event.y
    })

    // Hold at zoom
    keyframes.push({
      time: t + (settings.easeIn + holdDuration) / 1000,
      zoom: zoomLevel,
      centerX: event.x,
      centerY: event.y
    })

    // Zoom out complete
    keyframes.push({
      time: t + (settings.easeIn + holdDuration + settings.easeOut) / 1000,
      zoom: 1.0,
      centerX: event.x,
      centerY: event.y
    })
  }

  // Sort by time
  keyframes.sort((a, b) => a.time - b.time)

  return keyframes
}

/**
 * Build FFmpeg zoompan filter expression from keyframes
 *
 * The zoompan filter requires expressions for zoom, x, and y that evaluate per-frame.
 * We use nested if() expressions to handle each keyframe segment.
 */
export function buildZoompanFilter(
  keyframes: ZoomKeyframe[],
  resolution: { width: number; height: number },
  fps: number = 30
): string {
  if (keyframes.length === 0) {
    // No zoom effects, return identity (no zoompan needed)
    return ''
  }

  const { width, height } = resolution

  // Build zoom expression
  const zoomExpr = buildZoomExpression(keyframes)

  // Build x/y pan expressions (center point tracking)
  const xExpr = buildPanExpression(keyframes, 'x', width)
  const yExpr = buildPanExpression(keyframes, 'y', height)

  // zoompan filter: z=zoom, x=pan_x, y=pan_y, d=1 (1 frame per input frame), s=output size, fps=framerate
  // The filter outputs at the same resolution, zooming "into" the frame
  return `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`
}

/**
 * Build the zoom expression with easing between keyframes
 */
function buildZoomExpression(keyframes: ZoomKeyframe[]): string {
  if (keyframes.length === 0) return '1'
  if (keyframes.length === 1) return String(keyframes[0].zoom)

  // Build nested if expressions for each segment
  // if(between(t,t1,t2), lerp(z1,z2,eased_progress), next_segment)
  let expr = '1' // default zoom

  // Process keyframes in reverse to build nested ifs
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k1 = keyframes[i]
    const k2 = keyframes[i + 1]

    // t is time in seconds (provided by zoompan as 'time' or we use on/n*fps)
    // Progress within segment: (t - t1) / (t2 - t1)
    const t1 = k1.time.toFixed(3)
    const t2 = k2.time.toFixed(3)
    const z1 = k1.zoom.toFixed(3)
    const z2 = k2.zoom.toFixed(3)

    // Linear interpolation for now (can add easing later)
    // lerp: z1 + (z2 - z1) * progress
    // progress = (t - t1) / (t2 - t1)
    const segmentExpr = `(${z1}+(${z2}-${z1})*((t-${t1})/(${t2}-${t1})))`

    expr = `if(between(t,${t1},${t2}),${segmentExpr},${expr})`
  }

  // Handle before first keyframe (zoom = 1)
  const firstTime = keyframes[0].time.toFixed(3)
  expr = `if(lt(t,${firstTime}),1,${expr})`

  return expr
}

/**
 * Build pan expression for x or y coordinate
 */
function buildPanExpression(
  keyframes: ZoomKeyframe[],
  axis: 'x' | 'y',
  _size: number
): string {
  if (keyframes.length === 0) return `iw/2` // center

  // When zoomed, we need to offset the view to center on the click point
  // At zoom=1, pan should be 0 (centered)
  // At zoom>1, pan = (center_point - 0.5) * size * (zoom - 1)

  // The zoompan x/y is the top-left corner of the zoom window
  // To center on a point (cx, cy) at zoom level z:
  // x = cx * iw - (iw/z)/2 = cx * iw - iw/(2*z)
  // Simplified: x = iw * (cx - 1/(2*z))

  let expr = axis === 'x' ? 'iw/2-(iw/zoom)/2' : 'ih/2-(ih/zoom)/2'

  // For each keyframe segment, calculate the pan position
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k1 = keyframes[i]
    const k2 = keyframes[i + 1]

    const t1 = k1.time.toFixed(3)
    const t2 = k2.time.toFixed(3)

    const c1 = axis === 'x' ? k1.centerX : k1.centerY
    const c2 = axis === 'x' ? k2.centerX : k2.centerY
    const dim = axis === 'x' ? 'iw' : 'ih'

    // Interpolate center position
    const c1Str = c1.toFixed(4)
    const c2Str = c2.toFixed(4)
    const centerExpr = `(${c1Str}+(${c2Str}-${c1Str})*((t-${t1})/(${t2}-${t1})))`

    // Pan expression: center * dimension - (dimension / zoom) / 2
    // This centers the zoom window on the interpolated center point
    const panExpr = `(${centerExpr}*${dim}-(${dim}/zoom)/2)`

    expr = `if(between(t,${t1},${t2}),${panExpr},${expr})`
  }

  // Before first keyframe - center
  const firstTime = keyframes[0].time.toFixed(3)
  const defaultCenter = axis === 'x' ? 'iw/2-(iw/zoom)/2' : 'ih/2-(ih/zoom)/2'
  expr = `if(lt(t,${firstTime}),${defaultCenter},${expr})`

  return expr
}

/**
 * Process a recording session and return FFmpeg filter options
 */
export function processSession(session: RecordingSession): {
  hasEffects: boolean
  videoFilters: string[]
} {
  const filters: string[] = []

  // Generate zoom keyframes from click events
  const keyframes = generateZoomKeyframes(session.events, session.settings.clickZoom)

  if (keyframes.length > 0) {
    const zoompanFilter = buildZoompanFilter(keyframes, session.resolution)
    if (zoompanFilter) {
      filters.push(zoompanFilter)
    }
  }

  return {
    hasEffects: filters.length > 0,
    videoFilters: filters
  }
}

/**
 * Debug helper: print keyframes
 */
export function debugKeyframes(keyframes: ZoomKeyframe[]): void {
  console.log('[Demo] Zoom keyframes:')
  for (const kf of keyframes) {
    console.log(`  t=${kf.time.toFixed(2)}s zoom=${kf.zoom.toFixed(2)} center=(${kf.centerX.toFixed(3)}, ${kf.centerY.toFixed(3)})`)
  }
}
