# Claude Context — SleekRec

This directory contains documentation and context for Claude sessions working on SleekRec.

## Session Start Checklist

When starting a new session on SleekRec:

1. **Read `../CLAUDE.md`** — Project overview, architecture, commands
2. **Check current state** — `git status`, `git log -5 --oneline`
3. **Understand the task** — Ask clarifying questions before coding

## Documentation Index

| File | Purpose |
|------|---------|
| `../CLAUDE.md` | Main project context, architecture, conventions |
| `docs/demo-mode-architecture.md` | Phase 2 feature spec: smart demo video generation |

## Key Decisions Log

### 2025-01 — v1.0.0 Release
- Basic recording with pause/resume
- Quality presets (Low/Medium/High/Ultra)
- Always-on-top overlay during recording
- FFmpeg encoding pipeline (WebM → MP4)
- Cross-platform builds via GitHub Actions

### Planned — v2.0.0 Demo Mode
- Click-zoom effects
- Cursor smoothing
- Timeline editor
- Focus region markers
- See `docs/demo-mode-architecture.md` for full spec

## Code Style Notes

- **Minimal UI** — No unnecessary chrome, dark theme, purple accent
- **TypeScript strict** — Proper types, no `any` unless necessary
- **Electron IPC** — All main↔renderer communication via typed channels
- **React functional** — Hooks, no class components
- **Tailwind** — Utility classes, no custom CSS unless needed

## Common Pitfalls

1. **FFmpeg path in packaged app** — Must use `app.asar.unpacked` path
2. **ES Modules** — Don't add `"type": "module"` to package.json (breaks `__dirname`)
3. **Overlay window** — Needs `setVisibleOnAllWorkspaces` for macOS spaces
4. **Recording while minimized** — Set `backgroundThrottling: false`

## Testing Locally

```bash
npm run dev          # Start in development mode
# Recording saves to: ~/Videos/SleekRecordings/
# Settings at: %APPDATA%/sleek-recorder/settings.json (Windows)
```

## When Adding Features

1. Update types in relevant files
2. Add IPC handler in `electron/main.ts`
3. Expose via `electron/preload.ts`
4. Implement UI in `src/App.tsx` or new component
5. Update `../CLAUDE.md` if architecture changes
