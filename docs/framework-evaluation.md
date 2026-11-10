# Framework evaluation: keep Electron, make the shell replaceable

Written 2026-11-10 against 1.3.0 (Electron 44.9.3). Question: would another framework make
SleekRec smaller, faster or more capable? Answer: not for recording quality or speed, which the
shell does not touch; yes for install size and memory, but only after three engine pieces leave
Chromium. Those three moves are worth doing on their own, so they come first and the shell
decision is taken afterwards with measurements.

## What the shell does today

| Concern | Where it runs | Shell-dependent |
|---|---|---|
| GPU video capture and encode (ddagrab, NVENC/AMF/QSV/MF) | FFmpeg child process | No |
| MP4 finalize, export, trim, fit-to-size, replay segments | FFmpeg child processes | No |
| Display and window enumeration, job object, clipboard copy | `native/windows-displays.cpp` | No |
| System audio loopback and microphone | Chromium (`src/capture-audio.ts`, `src/pcm-worklet.js`), PCM over IPC to a named pipe | Yes |
| Source thumbnails and source IDs | `desktopCapturer` | Yes |
| Browser engine (windows, macOS, Linux) | `MediaRecorder` in Chromium | Yes |
| Overlay, toast, frame, region windows | transparent, click-through, capture-excluded `BrowserWindow`s | Needs equivalents |
| Hotkeys, tray, updater, login item | `globalShortcut`, `Tray`, `electron-updater` | Needs equivalents |

Video frames never enter Node or Chromium. A different shell cannot raise delivered frame rate,
lower encode latency or change file quality on the GPU engine.

## What Electron costs

Measured on the packaged 1.2.0 build in `dist_app/win-unpacked` (Electron 44; 1.3.0 not rebuilt
here): 352.6 MB unpacked, of which `SleekRec.exe` is 246.8 MB and all of `resources` (app code,
FFmpeg, helper) is 16.8 MB. The NSIS installer is 110 MB. About 95% of the install is the Chromium
runtime. Memory and startup time were not measured for this document; `plan-size-speed-safety.md`
has the idle CPU and working-set history.

Electron also causes two engine oddities, both in audio: desktop loopback must carry a 16x16
companion video track, and an audio-only request terminates the renderer on Electron 29 to 44
(`recording.md`, "Audio"). A recording therefore needs a live renderer for its whole duration.

## Options

**A. Keep Electron as is.** No risk, no gain. The untested 27 MB saving from excluding
`dxcompiler.dll` and `dxil.dll` (`plan-size-speed-safety.md`) remains available.

**B. Tauri 2 (Rust core, system WebView).** Expected install of a few tens of MB, since WebView2
ships with Windows 11. The React UI ports largely unchanged. Costs:
- About 3,000 lines of main-process TypeScript (`electron/*.ts`) are rewritten in Rust, including
  the stop-ordering and recovery contracts whose regressions truncate recordings.
- No `desktopCapturer`: thumbnails and source IDs must come from the helper.
- WebView2's `getDisplayMedia` shows a picker and gives no pickerless system loopback, so audio
  capture must be native before the port, not after.
- macOS and Linux lose their only engine. WKWebView and WebKitGTK do not offer the
  `MediaRecorder` plus screen capture path Chromium does. Those platforms would need native
  engines first, or be dropped.
- Updater, installer, signing and the five special windows are redone and re-verified.

The WebView2, WKWebView and WebKitGTK statements are from general knowledge and were not tested
in this evaluation; a port starts with a one-day spike that proves or disproves them.

**C. Fully native Windows app (Rust or C++, Windows.Graphics.Capture, encoder SDKs directly).**
The most headroom: true window capture including occluded windows, HDR, no FFmpeg process for
capture. Also a full rewrite of a working engine and the end of the cross-platform build. Not
justified while the FFmpeg graph meets its targets.

## Recommendation

Stay on Electron now. Move the three Chromium-bound engine pieces into the native helper. Each is
a product gain by itself and together they remove every reason the engine needs Chromium on
Windows.

1. **Native audio capture.** WASAPI loopback and microphone in the helper, writing PCM straight
   to the existing named pipe. Removes the companion video track, the renderer-kill hazard and the
   IPC hop from the audio path; lets a recording run with the main window destroyed; is the
   prerequisite for per-app audio (roadmap "Later"). Highest value, highest care: sync, mic
   mute, separate tracks and the bounded-queue rules in `recording.md` must hold.
2. **Helper thumbnails and source IDs.** Replaces `desktopCapturer` on Windows, which today runs
   on every picker refresh alongside two helper launches.
3. **True window capture** through Windows.Graphics.Capture, so window sources stop being
   recorded as screen areas. This is the capture feature a shell change could never deliver.

After step 2 the Windows engine is a helper plus FFmpeg behind a line protocol, which is also the
CLI the roadmap lists. At that point a Tauri shell for Windows is a contained UI port, and the
decision rests on measured numbers.

## When to reopen the shell decision

- Steps 1 and 2 have shipped, and
- install size or idle memory is a stated reason people do not adopt SleekRec, and
- macOS and Linux either have native engines or are officially out of scope.

Before committing, measure on the same machine: installer size, cold start to first paint, idle
working set, and working set while recording. Ship nothing on a size argument alone if the stop
and recovery tests have not been ported and passed.
