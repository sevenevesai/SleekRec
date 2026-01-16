# SleekRec

Lightweight MP4 screen recorder built with Electron + React + TypeScript.

## Quick Reference

```bash
npm run dev        # Start dev server
npm run build:win  # Build Windows installer
npm run build:mac  # Build macOS DMG
npm run build:linux # Build Linux AppImage/deb
npm run icons      # Generate icons from SVG
```

## Architecture

```
SleekRec/
├── electron/
│   ├── main.ts        # Electron main process, IPC handlers, FFmpeg encoding
│   └── preload.ts     # Context bridge for renderer
├── src/
│   ├── App.tsx        # Main React app, recording logic, UI state
│   ├── main.tsx       # React entry point
│   └── index.css      # Tailwind styles
├── build/
│   └── icon.svg       # Source icon (generate PNGs with npm run icons)
├── website/           # Landing page for seveneves.ai/sleekrec
└── .claude/docs/      # Feature specs and architecture docs
```

## Tech Stack

- **Electron 29** — Desktop shell, screen capture via `desktopCapturer`
- **React 18** — UI components
- **TypeScript** — Type safety
- **Vite** — Build tooling
- **Tailwind CSS** — Styling
- **FFmpeg (fluent-ffmpeg + ffmpeg-static)** — WebM → MP4 encoding

## Recording Pipeline

```
Screen/Window → MediaRecorder (VP9/WebM) → Temp file → FFmpeg → MP4 (H.264/AAC)
```

Quality presets in `electron/main.ts`:
- Low: CRF 32, ~3 MB/min
- Medium: CRF 28, ~6 MB/min
- High: CRF 23, ~12 MB/min
- Ultra: CRF 18, ~20 MB/min

## Key IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `get-sources` | renderer→main | List capturable windows/screens |
| `start-save-stream` | renderer→main | Init temp file for recording |
| `save-chunk` | renderer→main | Write video chunk to temp file |
| `stop-and-save` | renderer→main | Finalize, encode to MP4, open folder |
| `show-overlay` | renderer→main | Show recording overlay widget |
| `sync-timer` | renderer→main | Update overlay timer display |

## UI Components

- **Main window** — Source picker grid, settings modal, start recording
- **Overlay window** — Always-on-top pill with timer, pause/stop buttons
- **Settings** — Quality preset, output folder, thumbnail columns

## Conventions

- Dark theme with purple accent (`#BB86FC`)
- Minimal UI, no unnecessary chrome
- Settings persisted to `userData/settings.json`
- Output files: `Recording_YYYY-M-D_H-M-S.mp4`

## Current Version

v1.0.0 — Basic recording with pause, quality presets, overlay

## Planned Features

See `.claude/docs/demo-mode-architecture.md` for the "Demo Mode" feature spec — smart transitions, click-zoom, cursor smoothing for creating polished showcase videos.

## Common Tasks

### Adding a new IPC handler
1. Add handler in `electron/main.ts` using `ipcMain.handle()` or `ipcMain.on()`
2. Expose in `electron/preload.ts` via `contextBridge`
3. Call from renderer via `window.electronAPI.methodName()`

### Modifying recording behavior
- Capture logic: `src/App.tsx` in `startRecording()`
- Encoding options: `electron/main.ts` in `stop-and-save` handler

### Building for release
1. Update version in `package.json`
2. Run `npm run build:win` (or mac/linux)
3. Outputs to `dist_app/`
4. Tag release: `git tag v1.x.x && git push --tags`
