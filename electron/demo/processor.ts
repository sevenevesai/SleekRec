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
 * The zoompan filter uses these variables:
 * - 'on' = output frame number
 * - 'in_time' or we calculate time as on/fps
 * - 'zoom' = current zoom value (for use in x/y expressions)
 * - 'iw', 'ih' = input width/height
 *
 * We use nested if() expressions to handle each keyframe segment.
 */
export function buildZoompanFilter(
  keyframes: ZoomKeyframe[],
  resolution: { width: number; height: number },
  fps: number = 30
): string {
  if (keyframes.length === 0) {
    return ''
  }

  const { width, height } = resolution

  // Build zoom expression using frame number (on) to calculate time
  const zoomExpr = buildZoomExpression(keyframes, fps)

  // Build x/y pan expressions
  const xExpr = buildPanExpression(keyframes, 'x', width, fps)
  const yExpr = buildPanExpression(keyframes, 'y', height, fps)

  // zoompan: d=1 means 1 output frame per input frame, s=output size
  return `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`
}

/**
 * Build the zoom expression with easing between keyframes
 * Uses 'on' (output frame number) divided by fps to get time in seconds
 */
function buildZoomExpression(keyframes: ZoomKeyframe[], fps: number): string {
  if (keyframes.length === 0) return '1'
  if (keyframes.length === 1) return String(keyframes[0].zoom)

  // In zoompan, time is calculated as: on/fps (frame number / framerate)
  // We'll use 'time' variable which equals on*duration or we compute on/fps
  // Actually zoompan provides 'in_time' and 'out_time', let's use on/fps

  let expr = '1' // default zoom

  // Process keyframes in reverse to build nested ifs
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k1 = keyframes[i]
    const k2 = keyframes[i + 1]

    // Convert times to frame numbers for comparison
    const f1 = Math.round(k1.time * fps)
    const f2 = Math.round(k2.time * fps)
    const z1 = k1.zoom.toFixed(3)
    const z2 = k2.zoom.toFixed(3)

    // Linear interpolation using frame numbers
    // progress = (on - f1) / (f2 - f1)
    const duration = f2 - f1
    if (duration <= 0) continue

    const segmentExpr = `(${z1}+(${z2}-${z1})*((on-${f1})/${duration}))`
    expr = `if(between(on,${f1},${f2}),${segmentExpr},${expr})`
  }

  // Handle before first keyframe (zoom = 1)
  const firstFrame = Math.round(keyframes[0].time * fps)
  expr = `if(lt(on,${firstFrame}),1,${expr})`

  return expr
}

/**
 * Build pan expression for x or y coordinate
 * The pan position centers the zoom window on the click point
 */
function buildPanExpression(
  keyframes: ZoomKeyframe[],
  axis: 'x' | 'y',
  _size: number,
  fps: number
): string {
  if (keyframes.length === 0) return axis === 'x' ? 'iw/2-(iw/zoom)/2' : 'ih/2-(ih/zoom)/2'

  const dim = axis === 'x' ? 'iw' : 'ih'

  // Default: center of frame
  let expr = `${dim}/2-(${dim}/zoom)/2`

  // For each keyframe segment, calculate the pan position
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k1 = keyframes[i]
    const k2 = keyframes[i + 1]

    const f1 = Math.round(k1.time * fps)
    const f2 = Math.round(k2.time * fps)

    const c1 = axis === 'x' ? k1.centerX : k1.centerY
    const c2 = axis === 'x' ? k2.centerX : k2.centerY

    const duration = f2 - f1
    if (duration <= 0) continue

    // Interpolate center position (0-1 normalized)
    const c1Str = c1.toFixed(4)
    const c2Str = c2.toFixed(4)
    const centerExpr = `(${c1Str}+(${c2Str}-${c1Str})*((on-${f1})/${duration}))`

    // Pan expression: center * dimension - (dimension / zoom) / 2
    // This positions the zoom window so the center point is in the middle
    const panExpr = `(${centerExpr}*${dim}-(${dim}/zoom)/2)`

    expr = `if(between(on,${f1},${f2}),${panExpr},${expr})`
  }

  // Before first keyframe - center of frame
  const firstFrame = Math.round(keyframes[0].time * fps)
  const defaultCenter = `${dim}/2-(${dim}/zoom)/2`
  expr = `if(lt(on,${firstFrame}),${defaultCenter},${expr})`

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
    // Try simplified approach: use scale + overlay instead of zoompan for now
    // This is more reliable and easier to debug
    const simpleFilter = buildSimpleZoomFilter(keyframes, session.resolution, 30)
    if (simpleFilter) {
      filters.push(simpleFilter)
    }
  }

  return {
    hasEffects: filters.length > 0,
    videoFilters: filters
  }
}

/**
 * Build a simpler zoom filter using zoompan with basic expressions
 * This is more reliable than complex nested if statements
 */
function buildSimpleZoomFilter(
  keyframes: ZoomKeyframe[],
  resolution: { width: number; height: number },
  fps: number
): string {
  if (keyframes.length === 0) return ''

  const { width, height } = resolution

  // For simplicity, just pick the first click and zoom on it
  // This tests that the basic zoompan works before we add complexity
  const firstClick = keyframes.find(k => k.zoom > 1)
  if (!firstClick) return ''

  const startFrame = Math.round(firstClick.time * fps)
  const zoomDuration = 30 // frames for full zoom cycle (~1 second at 30fps)

  // Simple zoom: ramp up then down over ~1 second centered on the click
  // zoom expression: if we're in the zoom window, interpolate 1 -> 1.5 -> 1
  const zoomLevel = 1.5
  const cx = firstClick.centerX.toFixed(4)
  const cy = firstClick.centerY.toFixed(4)

  // Simple approach: zoom peaks at startFrame + zoomDuration/2
  // Use linear ramp up then down (triangle wave)
  const halfDuration = Math.floor(zoomDuration / 2)
  const peakFrame = startFrame + halfDuration
  const endFrame = startFrame + zoomDuration

  // Linear ramp: up from startFrame to peakFrame, down from peakFrame to endFrame
  const zoomExpr = `if(lt(on,${startFrame}),1,` +
    `if(lt(on,${peakFrame}),1+${(zoomLevel - 1).toFixed(2)}*(on-${startFrame})/${halfDuration},` +
    `if(lt(on,${endFrame}),1+${(zoomLevel - 1).toFixed(2)}*(${endFrame}-on)/${halfDuration},1)))`

  // Pan to center on click point during zoom
  const xExpr = `if(between(on,${startFrame},${endFrame}),` +
    `${cx}*iw-(iw/zoom)/2,iw/2-(iw/zoom)/2)`
  const yExpr = `if(between(on,${startFrame},${endFrame}),` +
    `${cy}*ih-(ih/zoom)/2,ih/2-(ih/zoom)/2)`

  return `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`
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
