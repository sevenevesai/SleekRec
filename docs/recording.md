# Recording engines

## Selection and scope

`src/recording.ts` owns settings, presets, capture metadata and IPC payload types.
`electron/main.ts` owns session admission, disk checks, sleep prevention and window lifecycle;
`electron/settings.ts` validates stored settings. `electron/preload.ts` and `src/vite-env.d.ts`
expose the same IPC contract. Update all three when changing a channel. Start handlers
acknowledge initialization before accepting chunks.

Automatic mode selects the native engine for Windows screens whose adapter has a working GPU
encoder (`gpuSupport` in `src/recording.ts`), and the browser engine for windows and other
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

## Native video: adapters and encoders

`electron/gpu-capture.ts` builds the command; `electron/native-recorder.ts` (`CaptureProcess`)
runs it. `ddagrab` runs inside `-filter_complex` on a device created for the adapter that owns the
display: `-init_hw_device d3d11va=sleekgpu:<adapter> -filter_hw_device sleekgpu`. The earlier
`-f lavfi -i ddagrab` input never received `-filter_hw_device` and always opened the default
adapter. Two FFmpeg facts make the explicit adapter safe:

- 6.1.1 created that device from the DXGI 1.0 factory, and `DuplicateOutput` rejects such devices
  ("Invalid output duplication argument"). `scripts/ffmpeg/patches/0002` uses `CreateDXGIFactory1`.
- An adapter index that does not enumerate makes FFmpeg open the default adapter without an
  error; it logs `Using device vvvv:dddd` only when the index resolved. Capture runs at
  `-loglevel info` and refuses to start unless that line names the display's vendor and device
  (`openedExpectedAdapter`). The helper enumerates adapters in FFmpeg's order and reports
  vendor, device, name and LUID per output; never derive DXGI indices from Electron screen IDs.

Each adapter is probed once per app session, per codec, by running the real capture graph for two
frames (`withEncoders`). The first family in vendor order that opens the expected adapter wins;
a probe that found nothing retries after a minute. Settings and the picker show the result.

| Adapter | Family | Path from the BGRA D3D11 frame | Rate control |
|---|---|---|---|
| NVIDIA | NVENC | Encoder reads the texture | `constqp`, QP 28/23/19; Ultra lossless 4:4:4 |
| AMD | AMF | Encoder reads the texture (patch 0001 adds BGRA) | `cqp`, same QPs; `speed` above 1080p120 |
| Intel | Quick Sync | Fixed pool (patch 0003), `hwmap` to QSV, `vpp_qsv` to NV12 BT.709 | CQP via `-q:v`, same QPs |
| Any | Media Foundation | `hwdownload`, CPU BGRA to NV12 BT.709 | Quality 55/70/82; hardware MFTs only |

Media Foundation copies every frame through system memory: about 145 fps at 1440p on the test
machine's CPU. FFmpeg 6.1's MF wrapper ignores `-g`, so it gets time-based forced keyframes.
Ultra stays NVENC-only; on other adapters the card says to choose High. Never substitute lossy
encoding for Ultra. Verified on hardware: NVENC and MF on an RTX 2080 Ti. AMF and QSV are probe-
gated and their options are checked against the bundled encoders' option tables in `npm test`,
but they have not run on AMD or Intel hardware; see the roadmap.

No resize filter or forced 30 fps conversion is inserted. Display refresh or the user's explicit
rate sets the capture target (up to 240 fps). Pass through capture timestamps without output
frame rescheduling. The bundled `ddagrab` can repeat the last image when the desktop has not
changed; encoded fps and packet pacing therefore do not measure unique game frames.

Ultra uses NVENC P1, lossless tuning and `rgb_mode=yuv444` (H.264 High 4:4:4 Predictive or
HEVC RExt). This preserves all YUV samples after NVENC's RGB-to-YUV conversion, not bit-identical
screen RGB, and needs a player/editor that accepts 4:4:4. Ultra stays MKV (below).

All presets use single-pass encoding, no lookahead, no B-frames and a 2 s GOP (1 s for replay).
NVENC uses eight surfaces with a two-frame output delay, which overlaps capture and encoding;
zero waits on each bitstream synchronously. No bitrate ceiling is imposed. Keep maximum fidelity
in the master and compression in the separate export path.

B-frames are disabled because the bundled encoder can produce invalid reorder timestamps
with irregular desktop delivery. Discard catch-up frames less than one millisecond apart,
then quantize encoder timestamps to Matroska's millisecond time base, inside the capture graph
before any conversion. These metadata filters leave surfaces on the GPU. Do not override NVENC's
BGRA conversion with BT.709 matrix tags: this version's RGB conversion signals BT.601. QSV and MF
convert with BT.709 and tag it. AMF's internal conversion matrix is unverified. HDR/10-bit are
not implemented.

The helper also launches FFmpeg in a Windows job with kill-on-close and watches Electron's
process handle. A dead parent must stop capture instead of leaving an orphan filling the disk.

## Regions and window areas

A region is a crop of one output: ddagrab's `offset_x`, `offset_y` and `video_size`, relative to
the output's desktop origin, cost nothing on the GPU. `clampRegion` keeps it inside the display,
moves odd offsets inward and rounds sizes down to even (4:2:0 needs it), minimum 64x64. The
mouse pointer is drawn relative to the crop. A region equal to the whole display records as the
screen. The picker (`region.html`, `src/region.ts`) covers one display; dragging draws a
rectangle and clicking takes a window's frame from the helper's `--window-rects`, returned as
its exact physical rectangle. While recording, a click-through, capture-excluded border sits
3 px outside the region.

A window area is that window's DWM frame when recording starts, clipped to its monitor. It does
not follow the window, and windows on top of it appear; the card says so. Minimized windows are
refused. Region and window-area sources are remembered for hotkey starts (`SourceRef`).

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

References: [FFmpeg ddagrab](https://ffmpeg.org/ffmpeg-filters.html#ddagrab),
[NVENC rate control](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html),
[DXGI DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput),
[Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer).
