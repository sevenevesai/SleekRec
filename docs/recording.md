# Recording engines

## Selection and scope

`src/recording.ts` owns settings, presets, capture metadata and IPC payload types.
`electron/main.ts` owns session admission, disk checks, sleep prevention and window lifecycle;
`electron/settings.ts` validates stored settings. `electron/preload.ts` and `src/vite-env.d.ts`
expose the same IPC contract. Update all three when changing a channel. Start handlers
acknowledge initialization before accepting chunks.

Automatic mode selects the native engine for Windows screens whose adapter has a working GPU
encoder (`gpuSupport` in `src/recording.ts`, [gpu-capture.md](gpu-capture.md)), and the browser engine for windows and other
platforms. An unmatched Windows screen, or one without an encoder, fails visibly; using its
browser path requires an explicit Browser setting. Never silently downgrade a screen when the
helper, display mapping or encoder probe fails. Screens and windows appear separately, GPU first.

The helper's `--windows` mode reports each HWND's monitor and DWM frame bounds in physical
pixels. Window cards use that monitor's refresh rate and offer two explicit GPU actions: record
the whole screen, or record the window's area (below). Never widen a selected window's capture
scope automatically. Sidecars include source ID/name, encoder, adapter, app version and preset
so an unexpected engine choice can be traced after recording.

Each source refresh runs `desktopCapturer` and spawns the helper twice, so the picker refreshes on
mount, on window focus (at most once per 2 s) and from Refresh sources, never on a timer. The
main window's `backgroundThrottling: false` disables the Page Visibility API; focus is the signal.

The 320 px recording overlay is a static page, `overlay.html` with `src/overlay.ts`, without React.
It reaches the main window only through the `timer-update`, `recording-stats` and `overlay-*`
channels, so the main window's pause, mic and stop handling (and stop ordering) stays in one place.

GPU capture supports SDR, unrotated displays on any adapter with an encoder. HDR outputs record
DWM's SDR conversion; the card warns. Select the screen containing a game. This is desktop
capture, not an injected game hook: other visible windows are included. Exclusive fullscreen
transitions, display changes, protected content and driver resets may interrupt capture.
Borderless fullscreen avoids mode switches. A real gameplay test is required before claiming
sustained 1440p/165 fps under load.

## GPU capture

The native engine runs ddagrab in `-filter_complex` on the adapter that owns the display, checks
FFmpeg opened that adapter, and encodes there with NVENC, AMF, Quick Sync or Media Foundation;
regions and window areas are ddagrab crops. Mechanism, encoder table, color handling and the
timestamp rules that keep B-frames off: [gpu-capture.md](gpu-capture.md).

## Audio

`src/capture-audio.ts` keeps system audio and microphone mixing independent of native video.
Electron 29 through 44 require desktop loopback to accompany a video track: requesting audio
alone terminates the renderer ("bad IPC message, reason 263", electron#42765, measured on 29.4.6
and 44.9.3 in [electron-upgrade.md](electron-upgrade.md)). Request a 16x16, 1 fps companion and
never use it as the recorded video.

An AudioWorklet sends interleaved float PCM and capture times through acknowledged IPC. Map
worklet sample time to the AudioContext output clock, then package PCM with timestamps in a
live Matroska pipe (`electron/pcm-matroska.ts`). The renderer queue is bounded at 2 MB per track.
Preserve ddagrab's video timestamps; never timestamp buffered packets by when FFmpeg reads them.
That creates duplicate timestamps and stutter. Asynchronous audio resampling corrects clock
drift, and a sample-count output timeline keeps AAC timestamps continuous. Preserve silence as
samples; dropping silence shortens the audio timeline. Native capture encodes AAC while recording.

**Separate microphone track** (GPU only; MediaRecorder writes one track). With system audio and
the microphone on and `micTrack: 'separate'`, the worklet takes three inputs from the same graph:
the mix, system audio, and the microphone after its gain node, so mute and volume apply to both
the mix and the mic track. Each message holds one block per track, and each Matroska cluster
holds one SimpleBlock per track with one capture timestamp, so FFmpeg's per-track resampling makes
identical corrections. Tracks are titled "Game + microphone", "Game", "Microphone"; only the mix
is flagged default, so single-track players and chat apps play everything.

The renderer's Content-Security-Policy (`index.html`) allows scripts only from `'self'`, and
worklet modules count as scripts. Load the worklet from a built file URL: `vite.config.ts`
keeps `.js` assets from being inlined as `data:` URLs, which Vite does by default below 4 KiB.
A `data:` or `blob:` worklet URL makes `addModule` reject and `startPCM` throw.

Keep `flags=res` in the audio filter. FFmpeg 6.1 otherwise starts without a resampler when input
and output rates match. Its first drift correction can initialize one with a reset clock,
insert elapsed-time silence and block capture. The clock-drift regression test detects this.

Preset channel count/sample rate drives capture, AudioContext, PCM and AAC together. Mic raw
input toggles echo cancellation, noise suppression and automatic gain together. Mic mute changes
the GainNode gain; keep the graph connected. Gain/mute/volume callback values remain refs.
The settings meter owns a separate stream and cancels pending acquisition on modal close.

## Stop, pause and recovery

Native capture writes MKV parts into a session folder under the output folder: periodic clusters
survive a crash. Stop sends FFmpeg `q` and waits for encoder/muxer drain. `electron/finalize.ts`
then stream-copies the part (or the concat of parts) once into `<session>.partial.mp4` with
`+faststart`, counting the copied video packets from the same read through a `framecrc` output.
The MP4 is renamed into place and the parts deleted only when the packet count equals the
capture's muxed packets, every stream is present and the duration matches within 1 s or 1%.
Otherwise the parts are joined into `<session>.mkv` and the sidecar and saved banner carry the
reason. The MP4 also falls back when free space is below the parts' size plus 512 MB. Ultra keeps
its MKV: 4:4:4 in MP4 plays no better. Finalize progress reaches the UI as `finalize-progress`.

A metadata probe (`electron/media-probe.ts`) reads the header to report duration; a JSON sidecar
records resolution, target rate, encoder, encoded frames, average rate and file size.
`electron/frame-pacing.ts` summarizes mux packet timestamps using a bounded histogram; native
telemetry shares stdout with FFmpeg progress. Record p95/max intervals and counts over 50/100 ms.
Reset the previous timestamp at segment boundaries so pauses are not counted as capture stalls.
Native save does not scan/decode the completed recording to collect these metrics.

Pause finishes a part. Resume opens a new part with the frozen session settings; a part whose
FFmpeg never started is skipped at stop. Keep PCM flowing until FFmpeg exits; closing the input
before it handles `q` can hang finalization. Forced termination after a timeout keeps the
partial files, and the recordings panel offers to recover them
([library-and-editing.md](library-and-editing.md)). MKV's periodic clusters improve
recoverability but do not guarantee recovery of the last frames after a crash or disk failure.

The browser stop sequence remains ordered:
1. Clear the timer and call `MediaRecorder.stop()` (also valid while paused).
2. In `onstop`, await serialized blob conversions and acknowledged IPC writes.
3. Await `flush-chunks`, then `WriteStream.end()` before invoking FFmpeg.

Breaking this ordering loses the tail of a recording. The browser queue is bounded at 64 MB;
write errors stop recording visibly. Completed chunk promises are not retained for the entire
session. Failed saves leave partial files in the output folder.

Both engines snapshot settings for the session, prevent concurrent starts and stop idempotently.
Close/quit requests finish the active capture. Low disk space triggers a stop before the volume
is full. Renderer death aborts the backend while preserving partial files. Instant replay shares
`CaptureProcess` with recording; see [instant-replay.md](instant-replay.md).

## Browser capture

Browser capture requests source dimensions and an explicit frame rate. Its bitrate scales with
actual negotiated width, height and fps. Negotiated fps is not a measurement of encoder delivery.
Probe MIME support and derive the codec flag from the same choice. H.264 capture stream-copies
video into MP4 and converts Opus to AAC. VP9 capture saves its WebM master without mandatory
software re-encoding or a forced frame-rate change. Read saved dimensions from the container:
initial track settings can describe the monitor before window frames arrive. H.264 remux sends
the same compressed packets to a framecrc sink for pacing statistics without a second read or
decode. FFmpeg 6.1 does not emit `stats_mux_pre` for stream copy. VP9 save currently reports actual
dimensions without encoded-pacing statistics. Exports, trims and fit-to-size copies are separate
operations: [library-and-editing.md](library-and-editing.md).

## Bundled FFmpeg

Windows runs a trimmed FFmpeg n6.1.1 from `vendor/ffmpeg/win32-x64/ffmpeg.exe`, packaged as
`resources/ffmpeg.exe`; `electron/ffmpeg.ts` resolves it, and macOS/Linux keep `ffmpeg-static`.
Keep the version at 6.1.1: the workarounds in this document describe that version's behaviour,
and a different version changes capture timing. Three small patches in `scripts/ffmpeg/patches`
apply on top, each explained in its header. The recipe, pins and configure line live in
[scripts/ffmpeg/README.md](../scripts/ffmpeg/README.md). The build holds only the components the
app and its tests use, so a missing one fails as FFmpeg error text from `runFfmpeg` (for example
`Unknown encoder` or `No such filter`). Add it to the configure line in
`scripts/ffmpeg/build-ffmpeg-win.sh`, rebuild, and rerun the gates; do not change capture
arguments to avoid it.

The bundled Windows FFmpeg can exit with status zero after refusing an existing output. The
runner checks that error text too; otherwise a false success could delete a retained master.

## Verification and remaining validation

The [September 2026 investigation](recording-investigation.md) records the supplied stuttering
clip's measured gaps and the unresolved original engine selection.

- `npx tsc --noEmit`: no diagnostics.
- `npm test` (22 tests): ordered writes, 120 fps retention, remux hash identity, VP9 preservation,
  duplicate stop, write failures, export overwrite rejection, continuous audio timestamps and
  clock drift; stored-settings and hotkey validation; GPU support, crops and capture graphs;
  every AMF/QSV/MF option present in the bundled encoders; three titled tracks with identical
  timestamps; MP4 finalize and its MKV fallback; library kinds, path guards and recovery; fast
  and exact trims; fit-to-size. With an encoder on this machine: Ultra 4:4:4 sample identity,
  cropped capture through each working family, and a real instant-replay save.
- `npm run test:recording`: Windows hardware smoke test through the app's UI; success prints
  `SMOKE PASS` after checking strictly increasing packet timestamps in every file. It records the
  first GPU screen at Ultra with system audio for 60 seconds, pause/resume, a Medium recording with
  separate tracks (Chromium's fake microphone) that must become an MP4 with four streams, a
  hotkey-started 640x360 region, an instant-replay save, and browser capture, then checks the
  library, a fast trim and a 10 MB fit. Uses an isolated profile under `.test-output`. Set
  `SLEEK_SMOKE_SECONDS` for a shorter development run. It does not measure game rendering load
  or visually certify synchronization.
- `npm run build:win`: emits NSIS/MSI and `win-unpacked` with the native helper and FFmpeg.

Before a release, test 30-40 minutes of the target game at 2560x1440/165, audio/visual cue sync at
start and end, fullscreen/Alt-Tab transitions, microphone mute, HEVC editor import, crash recovery
and a slow/full disk. Compare delivered frame pacing during moving gameplay; a static desktop
can deliver fewer frames even with ample encoder capacity. Run the unit and smoke tests on an AMD
and an Intel machine before claiming those encoders work. macOS/Linux use the browser path and
need platform-specific capture/audio verification.

References: [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer).
