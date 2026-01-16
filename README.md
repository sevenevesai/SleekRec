# SleekRec

Lightweight screen recorder. Click, record, MP4.

## Download

[seveneves.ai/sleekrec](https://seveneves.ai/sleekrec)

**Windows** — x64 installer
**macOS** — ARM64 / Intel DMG
**Linux** — AppImage / .deb

## Features

- Record screen or window to MP4 (H.264/AAC)
- Pause and resume
- Quality presets (Low / Medium / High / Ultra)
- Always-on-top overlay during recording
- Configurable output folder

## Build

```
npm install
npm run dev
```

Production build:
```
npm run build:win
npm run build:mac
npm run build:linux
```

## Stack

Electron + React + TypeScript + Vite + Tailwind
FFmpeg for encoding

## License

MIT — free for any use.
