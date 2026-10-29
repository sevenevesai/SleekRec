# Roadmap: frontier-worthy SleekRec

Written 2026-10-29 against the 1.2.0 code, the GitHub release assets, the September stutter
investigation, the running app, and the current state of Cap, Screen Studio, OBS and the NVIDIA
App. Positioning to keep: the fastest and most honest local recorder. No accounts, no cloud, no
timeline editor. Capture fidelity and delivery statistics are the product; sharing is one click.

The ranking follows the funnel an AI referral creates: download, install, first recording on
whatever hardware the person has, then a file they can drop into Discord or an editor. Each item
is a self-contained worker brief, which is why this file exceeds the plan size target.

| # | Item | Removes | Effort |
|---|---|---|---|
| 1 | Signed Windows installer, winget, Homebrew, Scoop | SmartScreen "Run anyway" on every install | S |
| 2 | GPU capture on AMD, Intel and hybrid laptops | Browser fallback for everyone without a default NVIDIA adapter | L |
| 3 | MP4 on stop, fit-to-size export, quieter save | MKV masters editors refuse; guessing at file size | S–M |
| 4 | Start hotkey, tray, remembered source | No way to start from inside a game | S |
| 5 | Instant replay: save the last N seconds | The feature gamers expect from ShadowPlay and Game Bar | M |
| 6 | Recordings panel | File pickers for export; Explorer popping on every save | M |
| 7 | Trim | Re-recording to cut a start and an end | M |
| 8 | Region and window capture on the GPU | Window cards falling to the slow engine | M |
| 9 | Microphone on its own track | Editors cannot separate voice from game | M |
| 10 | macOS and Linux verified, then a native macOS engine | Shipping unverified platforms | S, then L |

Later: HDR displays, countdown, webcam bubble, cursor effects, a CLI for automation, per-app
audio. Not doing: cloud upload or share links, accounts, a timeline editor, auto-zoom. Those are
Cap's and Screen Studio's product; SleekRec's is capture fidelity and trust.

## 1. Signed installer and package managers

The README install table tells Windows users to click "More info → Run anyway", and the macOS
updater only runs on a Developer ID-signed build. Every AI-referred download meets that wall.
Azure Trusted Signing (renamed Artifact Signing) costs about $10 a month, admits individuals in
the US and Canada, and signs from CI; electron-builder supports it through `azureSignOptions`
from version 25, so the devDependency moves up from 24.13 (check the 26 breaking changes).
Reputation still builds over the first days after a new certificate. Then publish manifests on
each release: winget through the `winget-releaser` action, a Homebrew cask (needs the notarized
DMG CI already produces when the Apple secrets are set), and a Scoop bucket. Assistants answer
"how do I install it" with a package-manager line once one exists.

## 2. GPU capture on AMD, Intel and hybrid laptops

`docs/recording.md` limits GPU capture to the default NVIDIA adapter. Everyone else gets the
browser engine, which the September investigation measured at a 23 fps mean for a 1440p
screen. That is roughly a quarter of desktop GPUs per the Steam survey, plus NVIDIA laptops whose
integrated GPU owns the display, so the default adapter is Intel or AMD even with a discrete
NVIDIA card.

Mechanism, verified in FFmpeg's `vsrc_ddagrab.c`: the filter uses a supplied `hw_device_ctx` and
creates a default D3D11 device only when none is given. The current command feeds ddagrab as an
`-f lavfi -i` input, which never receives `-filter_hw_device`; that is the probable reason the
adapter option documented as not working did nothing (unverified). Run ddagrab inside
`-filter_complex` with `-init_hw_device d3d11va=gpu:<index> -filter_hw_device gpu`, where the
index comes from the helper, which already identifies the adapter owning each output by LUID.
Encode on that device: `h264_amf` and `hevc_amf` accept D3D11 frames directly, QSV takes them
through `hwmap`, and `h264_mf` (Media Foundation, vendor neutral) is the fallback after
`hwdownload`. Rebuild the trimmed FFmpeg with `--enable-amf --enable-libvpl
--enable-mediafoundation`, the encoders and the `hwmap,hwdownload,hwupload` filters
(`scripts/ffmpeg/build-ffmpeg-win.sh`). Map the Low to High QP presets per encoder. Ultra's
lossless 4:4:4 stays NVENC-only and the card says so. The source card and the sidecar name the
encoder. Needs AMD and Intel test machines; the smoke test takes a vendor filter.

## 3. MP4 on stop, fit-to-size export, quieter save

The site promises "Click. Record. MP4." and GPU recordings land as MKV, which Premiere Pro and
DaVinci Resolve do not import and chat apps do not preview. After a clean stop and segment
join, stream-copy the MKV into MP4 with `+faststart`, verify it with the existing probe
(duration, both streams), then delete the MKV. A failed remux, a forced stop or a crash still
leaves the MKV, so recovery is unchanged; the MKV only ever mattered while recording. Ultra
stays MKV, since 4:4:4 in MP4 helps no player, and its card says so.

Replace "Smaller MP4" with "Fit under 10 / 25 / 50 / 100 / 500 MB" (Discord's free limit is
the smallest). Video bitrate is target bytes minus audio over duration; encode with NVENC VBR and
a matching maxrate and bufsize, or two-pass x264, then check the size and retry one step lower
when it overshoots. Stop calling `shell.showItemInFolder` on every save (three call sites in
`electron/main.ts`); the recordings panel from item 6 takes its place.

## 4. Start hotkey, tray, remembered source

`electron/main.ts` registers only stop and pause. Add a start-or-stop toggle that records the
last source with the current settings (default `Ctrl+Shift+F8`; avoid `Alt+F9` and `Alt+F10`,
which the NVIDIA App holds). Make all three configurable in Settings and show a conflict when
`globalShortcut.register` returns false. Add a tray icon with idle, recording and paused states,
a menu for start, stop and open folder, and a "start minimized to tray" setting.

## 5. Instant replay

Record continuously into a ring of short segments with FFmpeg's segment muxer
(`-f segment -segment_time 10 -segment_wrap N -reset_timestamps 1`) in the session folder.
The save hotkey joins the completed segments with the stream-copy concat path that pause and
resume already use, skipping the one being written. Disk use is bounded by N times the segment
size and respects the 512 MB floor. `frame-pacing.ts` already resets at segment boundaries. The
overlay shows "Replay armed" with the save key. GPU engine first; the browser engine can follow
with a bounded ring of MediaRecorder timeslices.

## 6. Recordings panel

Export today needs a file picker and nothing lists what was recorded. List the output folder:
thumbnail, duration, size, engine, codec and delivered fps from the sidecar; actions play, show
in folder, copy, export, trim and delete to the recycle bin (`shell.trashItem`). After a stop,
this panel shows with the new recording on top. Thumbnails: the trimmed FFmpeg has no image
encoder, so decode one frame to `rawvideo` over a pipe and build it with `nativeImage`.

## 7. Trim

In and out handles on a scrubber over a `<video>` preview. Default cut is stream copy from the
keyframe before the in point, which is instant; an "exact" option re-encodes through the
compress path. Set `-g` to one to two seconds in the native engine so keyframe cuts land close.
Output is a new file next to the source. Ultra 4:4:4 and HEVC previews may not play in Chromium;
fall back to a thumbnail scrubber.

## 8. Region and window capture on the GPU

ddagrab's `offset_x`, `offset_y` and `video_size` crop on the GPU for free. Add a drag-to-select
overlay over the chosen screen that snaps to window rectangles from the helper's `--windows`
mode, which already maps HWNDs in physical pixels. A window card then offers "Record this window
on the GPU": the window's rectangle at full rate, with the honest caveats that overlapping
windows show and the rectangle is fixed at start. Round the crop to even dimensions for 4:2:0.
The browser engine crops at export only.

## 9. Microphone on its own track

`src/capture-audio.ts` mixes system audio and microphone into one PCM stream. Add a setting
"Microphone: mixed, or separate track" that sends a second PCM stream through its own pipe and
muxes a second AAC track. Keep mixed as the default so plain players stay correct; export copies
both tracks.

## 10. macOS and Linux

The README says capture and system audio on macOS and Linux are unverified. First, run the
browser path on macOS 13+ and Ubuntu LTS, confirm whether Electron's loopback audio works on
macOS, and mark the install table rows "beta" until then. Then a native macOS engine: a Swift
helper on ScreenCaptureKit (video and system audio) piping to FFmpeg's `h264_videotoolbox`,
under the same file, stop and sidecar contracts as Windows. Linux stays on the browser engine;
PipeWire is the only Wayland route and is not worth a native engine yet.

## Later

- HDR: ddagrab `output_fmt=auto` returns float16 scRGB on IDXGIOutput5, tagged linear. Needs a
  GPU tonemap filter the trimmed build lacks, or HEVC Main10 with PQ metadata. Cheap step now:
  the helper reports advanced-color outputs and the card warns before recording.
- Countdown (small), webcam bubble (large on the GPU path, it needs compositing), cursor click
  effects and keystroke display.
- CLI: `SleekRec --record --screen 1 --seconds 30 --out <path>` with exit codes, so scripts and
  agents can drive it. The sidecar already gives them a machine-readable result.
- Per-app audio through WASAPI process loopback; needs native code.

## Small fixes alongside

- The header is not sticky: Settings and Refresh scroll out of reach on long source lists.
- A first-run capability line on the picker: "GPU capture: ready on <adapter>" or "not available
  on this GPU yet", so people learn the engine before their first recording, not from the sidecar.
