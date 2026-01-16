/**
 * Demo Mode Processor
 * Generates FFmpeg filter chains for zoom effects from recorded interaction events
 */

interface InteractionEvent {
  type: 'click' | 'focus' | 'idle-start' | 'idle-end'
  timestamp: number
  x: number  // normalized 0-1 (but may be out of range if click outside recorded area)
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
  centerY: number
}

interface ZoomSegment {
  startFrame: number
  peakFrame: number
  endFrame: number
  zoomLevel: number
  centerX: number  // clamped 0.1-0.9 to avoid edge issues
  centerY: number
}

const FPS = 30

/**
 * Clamp a value to a safe range for zoom centering
 * We use 0.1-0.9 to avoid zooming to edges which looks bad
 */
function clampCenter(v: number): number {
  return Math.max(0.15, Math.min(0.85, v))
}

/**
 * Generate zoom segments from click events
 * Filters out overlapping clicks and clamps coordinates
 */
function generateZoomSegments(
  events: InteractionEvent[],
  settings: DemoModeSettings['clickZoom']
): ZoomSegment[] {
  if (!settings.enabled) return []

  const clickEvents = events.filter(e => e.type === 'click' && !e.meta?.skip)
  const segments: ZoomSegment[] = []

  const easeInFrames = Math.round((settings.easeIn / 1000) * FPS)
  const holdFrames = Math.round((settings.holdDuration / 1000) * FPS)
  const easeOutFrames = Math.round((settings.easeOut / 1000) * FPS)
  const totalFrames = easeInFrames + holdFrames + easeOutFrames

  for (const event of clickEvents) {
    const zoomLevel = event.meta?.zoomLevel ?? settings.level
    const startFrame = Math.round((event.timestamp / 1000) * FPS)

    // Check if this segment would overlap with previous
    const lastSegment = segments[segments.length - 1]
    if (lastSegment && startFrame < lastSegment.endFrame + 5) {
      // Skip clicks that are too close together (need at least 5 frame gap)
      console.log(`[Demo] Skipping overlapping click at frame ${startFrame}`)
      continue
    }

    // Skip clicks with coordinates way outside the frame (likely off-screen clicks)
    if (event.x < 0 || event.x > 2 || event.y < 0 || event.y > 2) {
      console.log(`[Demo] Skipping out-of-bounds click at (${event.x.toFixed(2)}, ${event.y.toFixed(2)})`)
      continue
    }

    segments.push({
      startFrame,
      peakFrame: startFrame + easeInFrames,
      endFrame: startFrame + totalFrames,
      zoomLevel,
      centerX: clampCenter(event.x),
      centerY: clampCenter(event.y)
    })
  }

  console.log(`[Demo] Generated ${segments.length} zoom segments from ${clickEvents.length} clicks`)
  return segments
}

/**
 * Build FFmpeg zoompan filter for all zoom segments
 */
function buildMultiZoomFilter(
  segments: ZoomSegment[],
  resolution: { width: number; height: number }
): string {
  if (segments.length === 0) return ''

  const { width, height } = resolution

  // Build zoom expression for all segments
  const zoomExpr = buildZoomExpr(segments)

  // Build pan expressions
  const xExpr = buildPanExpr(segments, 'x')
  const yExpr = buildPanExpr(segments, 'y')

  const filter = `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${FPS}`

  console.log(`[Demo] Generated filter with ${segments.length} zoom effects`)
  return filter
}

/**
 * Build zoom expression handling all segments
 * Uses nested if statements: if(segment1, zoom1, if(segment2, zoom2, 1))
 */
function buildZoomExpr(segments: ZoomSegment[]): string {
  if (segments.length === 0) return '1'

  // Build from last to first so we can nest properly
  let expr = '1'  // default when not in any segment

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    const { startFrame, endFrame, zoomLevel } = seg

    // Simple triangle zoom: ramp up to midpoint, ramp down to end
    const midFrame = Math.round((startFrame + endFrame) / 2)
    const rampUp = midFrame - startFrame
    const rampDown = endFrame - midFrame

    const zoomDelta = (zoomLevel - 1).toFixed(3)

    // Ease in: 1 + delta * (frame - start) / rampUp
    // Ease out: 1 + delta * (end - frame) / rampDown
    const segExpr = `if(lt(on,${midFrame}),` +
      `1+${zoomDelta}*(on-${startFrame})/${rampUp},` +
      `1+${zoomDelta}*(${endFrame}-on)/${rampDown})`

    // Wrap in between check for this segment's range
    expr = `if(between(on,${startFrame},${endFrame}),${segExpr},${expr})`
  }

  return expr
}

/**
 * Build pan expression for x or y axis
 */
function buildPanExpr(segments: ZoomSegment[], axis: 'x' | 'y'): string {
  const dim = axis === 'x' ? 'iw' : 'ih'

  // Default: center of frame (when zoom=1, this keeps view centered)
  let expr = `${dim}/2-(${dim}/zoom)/2`

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    const center = axis === 'x' ? seg.centerX : seg.centerY

    // Pan to center the zoom on the click point
    // Formula: center * dimension - (dimension / zoom) / 2
    const panExpr = `${center.toFixed(4)}*${dim}-(${dim}/zoom)/2`

    expr = `if(between(on,${seg.startFrame},${seg.endFrame}),${panExpr},${expr})`
  }

  return expr
}

/**
 * Generate zoom keyframes (for debug output)
 */
export function generateZoomKeyframes(
  events: InteractionEvent[],
  settings: DemoModeSettings['clickZoom']
): ZoomKeyframe[] {
  const segments = generateZoomSegments(events, settings)
  const keyframes: ZoomKeyframe[] = []

  for (const seg of segments) {
    keyframes.push({
      time: seg.startFrame / FPS,
      zoom: 1.0,
      centerX: seg.centerX,
      centerY: seg.centerY
    })
    keyframes.push({
      time: seg.peakFrame / FPS,
      zoom: seg.zoomLevel,
      centerX: seg.centerX,
      centerY: seg.centerY
    })
    keyframes.push({
      time: seg.endFrame / FPS,
      zoom: 1.0,
      centerX: seg.centerX,
      centerY: seg.centerY
    })
  }

  return keyframes
}

/**
 * Process a recording session and return FFmpeg filter options
 */
export function processSession(session: RecordingSession): {
  hasEffects: boolean
  videoFilters: string[]
} {
  const filters: string[] = []

  // Generate zoom segments from click events
  const segments = generateZoomSegments(session.events, session.settings.clickZoom)

  if (segments.length > 0) {
    const filter = buildMultiZoomFilter(segments, session.resolution)
    if (filter) {
      filters.push(filter)
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
