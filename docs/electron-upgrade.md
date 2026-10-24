# Electron 29.4.6 to 44.9.3

44.9.3 was the newest patch release of the newest major with one on 2026-10-24 (45 had only 45.0.0).
It moves Chromium 122 to 152 and main-process Node.js 20.9.0 to 24.22.0. electron-builder 24.13.3,
Vite 5 and TypeScript 5 are unchanged. Audited against Electron's `docs/breaking-changes.md`, 30-45.

## Breaking changes against SleekRec

| Version | Change | SleekRec | Action |
|---|---|---|---|
| 42 | npm package no longer downloads the binary on postinstall; the first `require('electron')` does | `scripts/smoke-recording.cjs:11`, vite-plugin-electron dev launch | None. Both call `require('electron')`; CI never runs the binary (electron-builder fetches its own) |
| 42+ | `electron` 44, `@electron/get` 5 declare `engines.node >= 22.12.0` | `.github/workflows/build.yml:13` | CI Node 20 to 22. Node 20 still installs, with EBADENGINE warnings |
| 43 | `dialog.showOpenDialog` without `defaultPath` opens Downloads, no last-folder memory | `electron/main.ts:453` (output folder picker) | Passes the current output folder. The export dialog (`:377`) already did |
| 31 | `nativeImage.toDataURL` keeps the PNG colour space | `electron/main.ts:255` thumbnails | None. Thumbnails decode at 480x270 on both versions |
| 28 | `backgroundThrottling: false` covers every WebContents in the window | `electron/main.ts:134` | None. Already in effect on 29; one WebContents per window |
| 44.3 (45) | `chromeMediaSource: 'desktop'` rejects WebContents ids | `src/App.tsx:525-526`, `src/capture-audio.ts:36-37` | None. Both pass `desktopCapturer` screen/window ids; window capture and the loopback companion work on 44.9.3 |
| 45 | Sandboxed preloads lose `events`/`timers`/`url` shims and `Buffer`/`setImmediate`; `require` loads only `electron` | `electron/preload.ts` | None. Built `dist-electron/preload.js` contains one `require("electron")` and no `Buffer`, `process.env` or `setImmediate` |
| 45 | `ipcRenderer` uses a native EventEmitter without `once`/`listenerCount`/`init` statics | `electron/preload.ts` | None. Uses `invoke`, `send`, `on`, `removeListener` only |
| 45 | Screen/window capture reaches `setPermissionRequestHandler` as `display-capture` | none | None. No handler is set, so the default grant applies. A future handler must grant `display-capture` |
| 30-44 | Removed or changed `clipboard` (renderer), iframe Permission Policy, `File.path`, `console-message` args, `app.commandLine`, popups, `toBitmap` | none | Unused (grep of `electron/`, `src/`, HTML) |

## Windows behaviour checked on the packaged 44.9.3 build

- Overlay: 320x70 at x = work-area width - 340, y = 20; `WS_EX_TOPMOST`; transparent through
  DirectComposition (`WS_EX_NOREDIRECTIONBITMAP`, transparent page background);
  `setContentProtection(true)` gives display affinity `0x11` (`WDA_EXCLUDEFROMCAPTURE`).
- Overlay pause, resume, mic mute and stop drive the main window; `electronAPI` has 32 keys in both
  windows under `sandbox: true`.
- `globalShortcut`: Ctrl+Shift+F9/F10 report `isRegistered` on 29.4.6 and 44.9.3 (not pressed).
- `render-process-gone` still fires (reason `crashed`), so the abort at `electron/main.ts:162` holds.
- `powerSaveBlocker`, `shell.showItemInFolder`, `dialog`: unchanged APIs; exercised by native saves
  and the UI export without errors. Whether the blocker is active was not measured.
- `--enable-logging` (packaged, dev, smoke): no Electron deprecation warnings, CSP violations or
  sandbox/preload errors.

## Desktop loopback without a video track (electron#42765)

Probe: a hidden window with the app's preload and `webPreferences` requests
`getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })` while a second
window plays a 440 Hz tone at gain 0.1. The control adds the 16x16, 1 fps companion.

| Electron | With companion (shipped) | Audio only |
|---|---|---|
| 29.4.6 | 1 audio + 1 video track, RMS 0.0704 over 3 s | Renderer killed, "bad IPC message, reason 263", 2 of 2 trials |
| 44.9.3 | 1 audio + 1 video track, RMS 0.0703 over 3 s | Renderer killed, "bad IPC message, reason 263", 2 of 2 trials |

The companion in `src/capture-audio.ts` stays. Repeat the probe before removing it on a later major.

## Package size (`npm run build:win`)

| Output | 29.4.6 | 44.9.3 |
|---|---|---|
| `win-unpacked` | 309,359,448 B | 419,738,283 B (+110.4 MB) |
| NSIS `.exe` | 91,871,667 B | 127,823,356 B |
| `.msi` | 104,820,736 B | 141,418,496 B |

Growth: `SleekRec.exe` +70.6 MB, new `dxcompiler.dll` 25.7 MB and `dxil.dll` 1.5 MB, licence
file +11.3 MB, `resources.pak` +7.2 MB. The DirectX shader compiler likely serves Chromium's WebGPU
backend, which SleekRec does not use; removing it from the package is untested.
