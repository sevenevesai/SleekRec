# Recording engines

## Selection and scope

`src/recording.ts` owns settings, presets, capture metadata and IPC payload types.
`electron/main.ts` owns session admission, disk checks, sleep prevention and window lifecycle.
`electron/preload.ts` and `src/vite-env.d.ts` expose the same IPC contract. Update all three
when changing a channel. Start handlers acknowledge initialization before accepting chunks.

Automatic mode selects the native engine for supported Windows screens and the browser engine
for windows and other platforms. An unmatched Windows screen fails visibly; using its browser
path requires an explicit Browser setting. Never silently downgrade a screen when the helper or
display mapping fails. Screens and windows appear separately, with GPU screens first.

The helper's `--windows` mode locates each HWND's monitor in physical coordinates. Window cards
use that monitor's refresh rate and offer a separate whole-screen action. Never widen a selected
window's capture scope automatically. Sidecars include source ID/name, app version and preset
so an unexpected engine choice can be traced after recording.

Each source refresh runs `desktopCapturer` and spawns the helper twice, so the picker refreshes on
mount, on window focus (at most once per 2 s) and from Refresh sources, never on a timer. The
main window's `backgroundThrottling: false` disables the Page Visibility API; focus is the signal.

The 320 px recording overlay is a static page, `overlay.html` with `src/overlay.ts`, without React.
It reaches the main window only through the `timer-update`, `recording-stats` and `overlay-*`
channels, so the main window's pause, mic and stop handling (and stop ordering) stays in one place.

The native path currently supports SDR, unrotated displays on the default NVIDIA adapter on
Windows. Select the screen containing a game. This is desktop capture, not an injected game
hook: other visible windows are included. Exclusive fullscreen transitions, display changes,
protected content and driver resets may interrupt capture. Borderless fullscreen avoids mode
switches. A real gameplay test is required before claiming sustained 1440p/165 fps under load.

## Native video and quality

`electron/native-recorder.ts` runs FFmpeg's `ddagrab` into NVENC, keeping full-resolution video
on the GPU. H.264 is the default; HEVC is optional. No resize filter or forced
30 fps conversion is inserted. Display refresh or the user's explicit rate sets the capture
target (up to 240 fps). Pass through capture timestamps without output frame rescheduling.
The bundled `ddagrab` can repeat the last image when the desktop has not changed; encoded fps
and packet pacing therefore do not measure unique game frames.

`native/windows-displays.cpp` enumerates DXGI outputs and identifies the actual default D3D11
adapter by LUID. Electron display bounds are converted from DIP to pixels and matched against
DXGI rectangles. Do not derive DXGI indices from Electron screen IDs or Windows display names.
The bundled FFmpeg 6.1 lavfi source creates its own default device; an explicit adapter option
does not select that source's device. Other adapters remain unavailable until this is fixed
and tested with a newer FFmpeg or a dedicated capture implementation.

Low / Medium / High use NVENC P4 and QP 28 / 23 / 19 with 4:2:0 color. Ultra uses P1, lossless
tuning and `rgb_mode=yuv444` (H.264 High 4:4:4 Predictive or HEVC RExt). This preserves all YUV
samples after NVENC's RGB-to-YUV conversion, not bit-identical screen RGB. Ultra requires a
player/editor that accepts 4:4:4; stream-copying into MP4 does not improve decoder compatibility.
Smaller MP4 converts to ordinary 4:2:0. Never silently substitute lossy encoding for Ultra.

All presets use single-pass encoding, no lookahead, no B-frames and eight surfaces. A two-frame
output delay permits capture/encoding overlap; zero waits on each bitstream synchronously.
No bitrate ceiling is imposed. Motion, detail and codec determine size; Ultra can exceed several
GB/min. Keep maximum fidelity in the master and compression in the separate export path.

B-frames are disabled because the bundled encoder can produce invalid reorder timestamps
with irregular desktop delivery. Discard catch-up frames less than one millisecond apart,
then quantize encoder timestamps to Matroska's millisecond time base. Pass through the remaining
timestamps; catch-up frames otherwise round to equal DTS at muxing. These metadata filters
leave video surfaces on the GPU. Do not override NVENC's BGRA conversion with BT.709 matrix
tags: this version's RGB conversion signals BT.601. HDR/10-bit are not implemented.

The helper also launches FFmpeg in a Windows job with kill-on-close and watches Electron's
process handle. A dead parent must stop capture instead of leaving an orphan filling the disk.

## Audio

`src/capture-audio.ts` keeps system audio and microphone mixing independent of native video.
Electron 29 through 44 require desktop loopback to accompany a video track: requesting audio
alone terminates the renderer ("bad IPC message, reason 263", electron#42765, measured on 29.4.6
and 44.9.3 in [electron-upgrade.md](electron-upgrade.md)). Request a 16x16, 1 fps companion and
never use it as the recorded video.

An AudioWorklet sends interleaved float PCM and capture times through acknowledged IPC. Map
worklet sample time to the AudioContext output clock, then package PCM with timestamps in a
live Matroska pipe (`electron/pcm-matroska.ts`). The renderer queue is bounded at 2 MB. Preserve
ddagrab's video timestamps; never timestamp buffered packets by when FFmpeg reads them. That
creates duplicate timestamps and stutter. Asynchronous audio resampling corrects clock drift,
and a sample-count output timeline keeps AAC timestamps continuous. Preserve silence as samples;
dropping silence shortens the audio timeline. Native capture encodes AAC while recording.

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

Native capture writes one MKV segment directly into a session folder under the output folder.
Stop sends FFmpeg `q`, waits for encoder/muxer drain, then renames a single segment to its final
name. There is no full-video pass. A metadata probe reads the header to report duration; a JSON
sidecar records resolution, target rate, encoded frames, average rate and file size.
`electron/frame-pacing.ts` summarizes mux packet timestamps using a bounded histogram; native
telemetry shares stdout with FFmpeg progress. Record p95/max intervals and counts over 50/100 ms.
Reset the previous timestamp at segment boundaries so pauses are not counted as capture stalls.
Native save does not scan/decode the completed recording to collect these metrics.

Pause finishes a segment. Resume opens a new segment with the frozen session settings. Final
save joins multiple segments with stream copy; this adds disk I/O proportional to the recording.
Parts are removed only after the join succeeds. Keep PCM flowing until FFmpeg exits; closing
the input before it handles `q` can hang finalization. Forced termination after a timeout keeps
the partial files. MKV's periodic clusters improve recoverability but do not guarantee recovery
of the last frames after a crash or disk failure.

The browser stop sequence remains ordered:
1. Clear the timer and call `MediaRecorder.stop()` (also valid while paused).
2. In `onstop`, await serialized blob conversions and acknowledged IPC writes.
3. Await `flush-chunks`, then `WriteStream.end()` before invoking FFmpeg.

Breaking this ordering loses the tail of a recording. The browser queue is bounded at 64 MB;
write errors stop recording visibly. Completed chunk promises are not retained for the entire
session. Failed saves leave partial files in the output folder.

Both engines snapshot settings for the session, prevent concurrent starts and stop idempotently.
Close/quit requests finish the active capture. Low disk space triggers a stop before the volume
is full. Renderer death aborts the backend while preserving partial files.

## Browser capture and export

Browser capture requests source dimensions and an explicit frame rate. Its bitrate scales with
actual negotiated width, height and fps. Negotiated fps is not a measurement of encoder delivery.
Probe MIME support and derive the codec flag from the same choice. H.264 capture stream-copies
video into MP4 and converts Opus to AAC. VP9 capture saves its WebM master without mandatory
software re-encoding or a forced frame-rate change. Read saved dimensions from the container:
initial track settings can describe the monitor before window frames arrive. H.264 remux sends
the same compressed packets to a framecrc sink for pacing statistics without a second read or
decode. FFmpeg 6.1 does not emit `stats_mux_pre` for stream copy. VP9 save currently reports actual
dimensions without encoded-pacing statistics.

`electron/export-recording.ts` exports existing masters separately from recording. MP4 copy
preserves H.264/HEVC video and AAC audio; other audio converts to AAC. VP9 requires the compressed
MP4 option for broad H.264 playback. Compression tries NVENC QP 24 after a real initialization
probe, or uses libx264 CRF 23 when unavailable. Use at least 256x144 for the probe: 64x64 is rejected
by supported GPUs and incorrectly forces CPU export. Resolution and frame delivery remain unchanged;
file-size reduction is content-dependent. Existing destinations are never overwritten.

The bundled Windows FFmpeg can exit with status zero after refusing an existing output. The
runner checks that error text too; otherwise a false success could delete a retained master.

## Bundled FFmpeg

Windows runs a trimmed FFmpeg n6.1.1 from `vendor/ffmpeg/win32-x64/ffmpeg.exe`, packaged as
`resources/ffmpeg.exe`; `electron/ffmpeg.ts` resolves it, and macOS/Linux keep `ffmpeg-static`.
Keep the version at 6.1.1: the workarounds in this document describe that version's behaviour,
and a different version changes capture timing. The recipe, pins and configure line live in
[scripts/ffmpeg/README.md](../scripts/ffmpeg/README.md). The build holds only the components the
app and its tests use, so a missing one fails as FFmpeg error text from `runFfmpeg` (for example
`Unknown encoder` or `No such filter`). Add it to the configure line in
`scripts/ffmpeg/build-ffmpeg-win.sh`, rebuild, and rerun the gates; do not change capture
arguments to avoid it.

## Verification and remaining validation

The [September 2026 investigation](recording-investigation.md) records the supplied stuttering
clip's measured gaps and the unresolved original engine selection.

- `npx tsc --noEmit`: no diagnostics.
- `npm test`: tests ordered writes, 120 fps retention, video hash identity after remux, VP9
  preservation, duplicate stop, write failures, export overwrite rejection, compressed output,
  actual saved dimensions, packet pacing, pause boundaries, continuous audio timestamps and
  clock-drift correction without inserted silence. With NVENC available, verify exact decoded
  4:4:4 sample identity through Ultra H.264 and HEVC; otherwise that hardware case is skipped.
- `npm run test:recording`: Windows/NVIDIA hardware test; success prints `SMOKE PASS` after checking
  strictly increasing video/audio packet timestamps. It records
  the first supported screen with system audio for 60 seconds, tests pause/resume, then browser
  capture. Uses an isolated profile under `.test-output`. Set `SLEEK_SMOKE_SECONDS` for a shorter
  development run. It does not measure game rendering load or visually certify synchronization.
- `npm run build:win`: emits NSIS/MSI and `win-unpacked` with the native helper and FFmpeg.

Before a release, test 30-40 minutes of the target game at 2560x1440/165, audio/visual cue sync at
start and end, fullscreen/Alt-Tab transitions, microphone mute, HEVC editor import, crash recovery
and a slow/full disk. Compare delivered frame pacing during moving gameplay; a static desktop
can deliver fewer frames even with ample encoder capacity. macOS/Linux use the browser path and
need platform-specific capture/audio verification.

References: [FFmpeg ddagrab](https://ffmpeg.org/ffmpeg-filters.html#ddagrab),
[NVENC rate control](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html),
[Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer).
