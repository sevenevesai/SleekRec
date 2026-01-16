# Demo Mode — Technical Architecture

**Status:** Planned
**Target:** v2.0.0
**Purpose:** Transform raw screen recordings into polished showcase videos with smart transitions, click-zoom effects, and cursor smoothing.

---

## Overview

Demo Mode captures user interactions (clicks, focus markers) alongside video, then processes them into professional-looking demo videos automatically. The user records normally, optionally marking focus points, then the system generates zoom effects, smooth transitions, and clean cursor overlays.

---

## Phase 1: Click-Zoom Recording (MVP)

### Goals
- Record video + interaction events (mouse position, clicks, timestamps)
- Auto-zoom to click points with smooth easing
- Replace system cursor with clean overlay
- Smooth cursor movement with bézier interpolation
- Export processed MP4 with effects baked in

### Data Structures

```typescript
interface InteractionEvent {
  type: 'click' | 'focus' | 'idle-start' | 'idle-end';
  timestamp: number;      // ms from recording start
  x: number;              // screen coordinates
  y: number;
  button?: 'left' | 'right' | 'middle';
  meta?: {
    zoomLevel?: number;   // override default zoom (1.0 = 100%)
    duration?: number;    // override hold duration
    skip?: boolean;       // marked for exclusion in editor
  };
}

interface CursorFrame {
  timestamp: number;
  x: number;
  y: number;
  visible: boolean;
  clicking: boolean;
}

interface RecordingSession {
  video: string;                    // path to raw WebM
  events: InteractionEvent[];
  cursorFrames: CursorFrame[];      // sampled at 60fps
  duration: number;
  resolution: { width: number; height: number };
  settings: DemoModeSettings;
}

interface DemoModeSettings {
  clickZoom: {
    enabled: boolean;
    level: number;          // default 1.5 = 150%
    easeIn: number;         // ms, default 250
    easeOut: number;        // ms, default 300
    holdDuration: number;   // ms, default 400
  };
  cursor: {
    hide: boolean;          // hide system cursor
    overlay: 'none' | 'dot' | 'pointer' | 'custom';
    smoothing: number;      // 0-1, bezier tension
    clickEffect: 'none' | 'ripple' | 'pulse' | 'highlight';
    clickEffectSize: number;
    clickEffectColor: string;
  };
  transitions: {
    idleThreshold: number;  // ms before marking idle (default 1500)
    idleSpeedup: number;    // playback speed during idle (default 3)
    fadeOnJump: boolean;    // fade when cursor teleports
  };
}
```

### Recording Pipeline (Modified)

```
┌─────────────────────────────────────────────────────────────────┐
│                        RECORDING PHASE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Screen       │    │ Mouse        │    │ Keyboard     │      │
│  │ Capture      │    │ Listener     │    │ Listener     │      │
│  │ (MediaRec)   │    │ (position,   │    │ (for idle    │      │
│  │              │    │  clicks)     │    │  detection)  │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐      │
│  │              Event Synchronizer                       │      │
│  │   - Timestamps all inputs to common timeline          │      │
│  │   - Samples cursor position at 60fps                  │      │
│  │   - Detects idle periods                              │      │
│  └──────────────────────────┬───────────────────────────┘      │
│                             │                                   │
│                             ▼                                   │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │ video.webm      │  │ session.json    │                      │
│  │ (raw footage)   │  │ (events, cursor │                      │
│  │                 │  │  frames, meta)  │                      │
│  └─────────────────┘  └─────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Processing Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                       PROCESSING PHASE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │ video.webm      │  │ session.json    │                      │
│  └────────┬────────┘  └────────┬────────┘                      │
│           │                    │                                │
│           ▼                    ▼                                │
│  ┌──────────────────────────────────────────────────────┐      │
│  │              Effect Calculator                        │      │
│  │                                                       │      │
│  │  For each click event:                               │      │
│  │   1. Calculate zoom keyframes (in, hold, out)        │      │
│  │   2. Calculate viewport transform at each frame      │      │
│  │                                                       │      │
│  │  For cursor frames:                                  │      │
│  │   1. Apply bézier smoothing                          │      │
│  │   2. Detect "teleports" (large jumps)                │      │
│  │   3. Generate click effect frames                    │      │
│  │                                                       │      │
│  │  For idle periods:                                   │      │
│  │   1. Mark segments for speed adjustment              │      │
│  │                                                       │      │
│  └──────────────────────────┬───────────────────────────┘      │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────┐      │
│  │              FFmpeg Render Pass                       │      │
│  │                                                       │      │
│  │  1. Apply zoom/pan transforms (zoompan filter)       │      │
│  │  2. Speed adjustment (setpts filter)                 │      │
│  │  3. Overlay cursor (overlay filter)                  │      │
│  │  4. Apply click effects (blend/overlay)              │      │
│  │  5. Encode final MP4                                 │      │
│  │                                                       │      │
│  └──────────────────────────┬───────────────────────────┘      │
│                             │                                   │
│                             ▼                                   │
│  ┌─────────────────────────────────────────────────────┐       │
│  │                    output.mp4                        │       │
│  │              (processed demo video)                  │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### FFmpeg Filter Chain

```bash
# Conceptual filter chain for a single click-zoom effect

ffmpeg -i raw.webm \
  -vf "
    # Zoom/pan based on calculated keyframes
    zoompan=z='if(between(t,1.0,1.25),1+0.5*(t-1.0)/0.25,if(between(t,1.25,1.65),1.5,if(between(t,1.65,1.95),1.5-0.5*(t-1.65)/0.3,1)))':
           x='if(between(t,1.0,1.95),iw/2-(iw/2-500)*...,iw/2)':
           y='if(between(t,1.0,1.95),ih/2-(ih/2-300)*...,ih/2)':
           d=1:s=1920x1080,

    # Speed adjustment for idle sections
    setpts='if(between(T,5,8),PTS/3,PTS)',

    # Cursor overlay (pre-rendered smooth cursor video)
    overlay=x='..smoothed_x..':y='..smoothed_y..'
  " \
  -c:v libx264 -preset medium -crf 23 \
  output.mp4
```

### Implementation Approach

Given FFmpeg filter complexity for dynamic keyframes, consider **frame-by-frame rendering**:

```typescript
// Pseudo-code for frame-by-frame processing

async function processDemo(session: RecordingSession): Promise<string> {
  const frames = await extractFrames(session.video);
  const outputFrames: Buffer[] = [];

  for (let i = 0; i < frames.length; i++) {
    const timestamp = i * (1000 / 60); // assuming 60fps

    // Calculate current zoom state
    const zoom = calculateZoomAtTime(timestamp, session.events, session.settings);

    // Apply zoom transform to frame
    let frame = applyZoomPan(frames[i], zoom);

    // Get smoothed cursor position
    const cursor = getSmoothedCursor(timestamp, session.cursorFrames, session.settings);

    // Draw cursor overlay
    if (cursor.visible) {
      frame = drawCursor(frame, cursor, session.settings.cursor);
    }

    // Draw click effect if active
    const clickEffect = getActiveClickEffect(timestamp, session.events);
    if (clickEffect) {
      frame = drawClickEffect(frame, clickEffect, session.settings.cursor);
    }

    outputFrames.push(frame);
  }

  return encodeFramesToVideo(outputFrames);
}
```

**Trade-off:** Frame-by-frame is slower but simpler to implement and debug. Can optimize later with FFmpeg filter expressions or GPU acceleration.

### Cursor Smoothing Algorithm

```typescript
// Bézier smoothing for cursor path

function smoothCursorPath(
  frames: CursorFrame[],
  tension: number = 0.5
): CursorFrame[] {

  const smoothed: CursorFrame[] = [];

  for (let i = 0; i < frames.length; i++) {
    const p0 = frames[Math.max(0, i - 1)];
    const p1 = frames[i];
    const p2 = frames[Math.min(frames.length - 1, i + 1)];
    const p3 = frames[Math.min(frames.length - 1, i + 2)];

    // Catmull-Rom to Bézier conversion
    const smoothedX = catmullRom(p0.x, p1.x, p2.x, p3.x, tension);
    const smoothedY = catmullRom(p0.y, p1.y, p2.y, p3.y, tension);

    smoothed.push({
      ...p1,
      x: smoothedX,
      y: smoothedY
    });
  }

  return smoothed;
}

// Detect cursor "teleports" (fade out/in instead of smooth)
function detectTeleports(
  frames: CursorFrame[],
  threshold: number = 0.3  // 30% of screen
): number[] {

  const teleportIndices: number[] = [];

  for (let i = 1; i < frames.length; i++) {
    const dx = Math.abs(frames[i].x - frames[i-1].x);
    const dy = Math.abs(frames[i].y - frames[i-1].y);
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (dist > threshold * Math.max(screenWidth, screenHeight)) {
      teleportIndices.push(i);
    }
  }

  return teleportIndices;
}
```

### Click Zoom Keyframe Generation

```typescript
interface ZoomKeyframe {
  time: number;      // ms
  zoom: number;      // 1.0 = 100%
  centerX: number;   // 0-1 normalized
  centerY: number;
}

function generateZoomKeyframes(
  event: InteractionEvent,
  settings: DemoModeSettings['clickZoom']
): ZoomKeyframe[] {

  const { level, easeIn, holdDuration, easeOut } = settings;
  const t = event.timestamp;

  return [
    // Start zoom in
    { time: t, zoom: 1.0, centerX: event.x, centerY: event.y },

    // Fully zoomed
    { time: t + easeIn, zoom: level, centerX: event.x, centerY: event.y },

    // Hold
    { time: t + easeIn + holdDuration, zoom: level, centerX: event.x, centerY: event.y },

    // Zoom out complete
    { time: t + easeIn + holdDuration + easeOut, zoom: 1.0, centerX: event.x, centerY: event.y },
  ];
}

function calculateZoomAtTime(
  time: number,
  events: InteractionEvent[],
  settings: DemoModeSettings
): { zoom: number; centerX: number; centerY: number } {

  // Find active zoom keyframes
  const allKeyframes = events
    .filter(e => e.type === 'click' && !e.meta?.skip)
    .flatMap(e => generateZoomKeyframes(e, settings.clickZoom));

  // Sort by time
  allKeyframes.sort((a, b) => a.time - b.time);

  // Find surrounding keyframes and interpolate
  let prev = allKeyframes.findLast(k => k.time <= time);
  let next = allKeyframes.find(k => k.time > time);

  if (!prev) return { zoom: 1, centerX: 0.5, centerY: 0.5 };
  if (!next) return prev;

  // Ease interpolation
  const t = (time - prev.time) / (next.time - prev.time);
  const eased = easeInOutCubic(t);

  return {
    zoom: lerp(prev.zoom, next.zoom, eased),
    centerX: lerp(prev.centerX, next.centerX, eased),
    centerY: lerp(prev.centerY, next.centerY, eased),
  };
}
```

---

## Phase 2: Timeline Editor

### UI Components

```
┌─────────────────────────────────────────────────────────────────┐
│  Preview Player                                    [▶] [⏸] [■] │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │                                                             │ │
│ │                    Video Preview                            │ │
│ │                    (with effects)                           │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Timeline                                                       │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ▼ Zoom Events                                               │ │
│ │ ──●────────●──────●───────────●────●──────────────●──────── │ │
│ │   ^        ^      ^           ^    ^              ^         │ │
│ │  0:02    0:05   0:08        0:15 0:17           0:28        │ │
│ │                                                             │ │
│ │ ▼ Speed Regions                                             │ │
│ │ ━━━━━━━━━━━━━━════════━━━━━━━━━━━━━━════════━━━━━━━━━━━━━━━ │ │
│ │              [3x]              [2x]                         │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Selected: Click @ 0:05                                         │
│  ┌────────────────────────────────────┐                        │
│  │ Zoom Level: [====●=====] 150%      │                        │
│  │ Hold Time:  [==●=======] 400ms     │                        │
│  │ [Delete] [Skip] [Reset to Default] │                        │
│  └────────────────────────────────────┘                        │
│                                                                 │
│                              [Export Demo Video]                │
└─────────────────────────────────────────────────────────────────┘
```

### Editor State

```typescript
interface EditorState {
  session: RecordingSession;
  playheadTime: number;
  playing: boolean;
  selectedEventIndex: number | null;
  previewQuality: 'draft' | 'full';  // draft = skip effects for speed

  // Undo/redo
  history: RecordingSession[];
  historyIndex: number;
}

type EditorAction =
  | { type: 'DELETE_EVENT'; index: number }
  | { type: 'SKIP_EVENT'; index: number }
  | { type: 'UPDATE_EVENT_META'; index: number; meta: Partial<InteractionEvent['meta']> }
  | { type: 'ADD_SPEED_REGION'; start: number; end: number; speed: number }
  | { type: 'UNDO' }
  | { type: 'REDO' };
```

---

## Phase 3: Focus Regions

### Recording UX

```
During recording:
- F key or Right-click = Drop focus marker at cursor position
- Shift+Right-drag = Define focus rectangle
- Double-right-click = Reset to full view marker
```

### Focus Event Type

```typescript
interface FocusEvent extends InteractionEvent {
  type: 'focus';
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // If no region, zoom to point (like click)
  // If region, zoom to fit region in frame
}
```

---

## Files to Create/Modify

### New Files

```
electron/
├── demo/
│   ├── recorder.ts      # Extended recording with event capture
│   ├── processor.ts     # Effect calculation and rendering
│   ├── cursor.ts        # Cursor smoothing and overlay
│   ├── zoom.ts          # Zoom keyframe generation
│   └── effects.ts       # Click effects, transitions

src/
├── components/
│   ├── DemoEditor/
│   │   ├── Timeline.tsx
│   │   ├── EventMarker.tsx
│   │   ├── SpeedRegion.tsx
│   │   ├── Preview.tsx
│   │   └── Controls.tsx
│   └── DemoRecorder/
│       └── DemoOverlay.tsx  # Recording UI with focus controls
├── hooks/
│   └── useDemoEditor.ts
└── types/
    └── demo.ts           # All demo mode types
```

### Modified Files

```
electron/main.ts         # New IPC handlers for demo mode
electron/preload.ts      # Expose demo APIs
src/App.tsx              # Demo mode toggle, routing to editor
```

---

## Performance Considerations

1. **Frame extraction** — Use FFmpeg to extract frames to temp directory, process in batches
2. **Preview rendering** — Use draft mode (lower res, skip some effects) for real-time preview
3. **Final render** — Background process with progress reporting
4. **Memory** — Stream frames, don't load entire video into memory
5. **Cursor sampling** — 60fps is sufficient, interpolate for higher framerates

---

## MVP Milestones

### Milestone 1: Event Capture
- [ ] Add mouse position tracking during recording
- [ ] Capture click events with timestamps
- [ ] Save session.json alongside video

### Milestone 2: Basic Zoom Processing
- [ ] Parse session.json
- [ ] Generate zoom keyframes from clicks
- [ ] Apply zoompan filter via FFmpeg
- [ ] Export processed video

### Milestone 3: Cursor Overlay
- [ ] Sample cursor at 60fps during recording
- [ ] Implement bézier smoothing
- [ ] Render cursor overlay in post
- [ ] Add click ripple effect

### Milestone 4: Timeline Editor
- [ ] Basic timeline UI with event markers
- [ ] Delete/skip events
- [ ] Adjust zoom level per event
- [ ] Preview with effects

### Milestone 5: Focus Regions
- [ ] F-key focus markers during recording
- [ ] Right-drag focus rectangles
- [ ] Process focus events as zoom targets

---

## Open Questions

1. **Real-time preview** — Can we preview effects during editing without full render? Consider WebGL/Canvas for real-time zoom simulation.

2. **Audio handling** — Speed changes affect audio. Options: pitch-correct, remove audio for sped sections, or leave as-is.

3. **Multi-monitor** — How to handle recordings spanning multiple displays?

4. **Cursor capture** — System cursor position vs captured cursor in video. May need to hide system cursor during recording and overlay our own in both raw and processed.
