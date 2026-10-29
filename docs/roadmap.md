# Roadmap: frontier-worthy SleekRec

Written 2026-10-29 against the 1.2.0 code, the GitHub release assets, the September stutter
investigation, the running app, and the current state of Cap, Screen Studio, OBS and the NVIDIA
App. Positioning to keep: the fastest and most honest local recorder. No accounts, no cloud, no
timeline editor. Capture fidelity and delivery statistics are the product; sharing is one click.

The ranking follows the funnel an AI referral creates: download, install, first recording on
whatever hardware the person has, then a file they can drop into Discord or an editor.

| # | Item | Removes | State |
|---|---|---|---|
| 1 | Signed Windows installer, winget, Homebrew, Scoop | SmartScreen "Run anyway" on every install | Open |
| 2 | GPU capture on AMD, Intel and hybrid laptops | Browser fallback for everyone without a default NVIDIA adapter | Built; AMD/Intel hardware runs pending |
| 3 | MP4 on stop, fit-to-size export, quieter save | MKV masters editors refuse; guessing at file size | Done |
| 4 | Start hotkey, tray, remembered source | No way to start from inside a game | Done |
| 5 | Instant replay: save the last N seconds | The feature gamers expect from ShadowPlay and Game Bar | Done |
| 6 | Recordings panel | File pickers for export; Explorer popping on every save | Done |
| 7 | Trim | Re-recording to cut a start and an end | Done |
| 8 | Region and window capture on the GPU | Window cards falling to the slow engine | Done |
| 9 | Microphone on its own track | Editors cannot separate voice from game | Done |
| 10 | macOS and Linux verified, then a native macOS engine | Shipping unverified platforms | Open |

Items 2-9 shipped together on 2026-10-29. Their designs live where they are maintained:
[gpu-capture.md](gpu-capture.md) (adapters, encoders, areas), [recording.md](recording.md)
(separate tracks, MP4 finalize), [instant-replay.md](instant-replay.md),
[library-and-editing.md](library-and-editing.md) (panel, trim, export, fit-to-size, recovery) and
[hotkeys-and-tray.md](hotkeys-and-tray.md). The two small fixes, a sticky header and a GPU
capability line on the picker, shipped with them.

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

## 2. Remaining validation for AMD and Intel

The AMF and Quick Sync paths are implemented, probe-gated and option-checked, but have only run
on an NVIDIA machine, whose integrated AMD GPU is disabled in Device Manager. Before calling them
supported:

- Run `npm test` and `npm run test:recording` on an AMD desktop, an Intel iGPU laptop, and an
  NVIDIA Optimus laptop whose panel belongs to the iGPU. The smoke test records the first GPU
  screen, which there is the iGPU's.
- AMF: check decoded colors against the source (its BGRA-to-YUV matrix and VUI tags are
  unverified) and real-time delivery at 1440p165 with `-quality speed`.
- QSV: confirm the fixed 32-frame pool (`extra_hw_frames=24`) never starves under load, and that
  `vpp_qsv` BT.709 output matches its tags.
- If an encoder fails there, the probe falls back to Media Foundation and Settings names the
  failing encoder; collect that text.

## 10. macOS and Linux

The README says capture and system audio on macOS and Linux are unverified. First, run the
browser path on macOS 13+ and Ubuntu LTS, confirm whether Electron's loopback audio works on
macOS, and mark the install table rows "beta" until then. Then a native macOS engine: a Swift
helper on ScreenCaptureKit (video and system audio) piping to FFmpeg's `h264_videotoolbox`,
under the same file, stop and sidecar contracts as Windows. Linux stays on the browser engine;
PipeWire is the only Wayland route and is not worth a native engine yet. Region capture,
instant replay and separate tracks are GPU-engine features today; the macOS engine would bring
them there.

## Later

- HDR: ddagrab `output_fmt=auto` returns float16 scRGB on IDXGIOutput5, tagged linear. Needs a
  GPU tonemap filter the trimmed build lacks, or HEVC Main10 with PQ metadata. The helper now
  reports advanced-color outputs and the card warns before recording.
- Recording while instant replay is armed by pinning segments (pre-roll for recordings); see
  [instant-replay.md](instant-replay.md).
- Countdown (small), webcam bubble (large on the GPU path, it needs compositing), cursor click
  effects and keystroke display.
- CLI: `SleekRec --record --screen 1 --seconds 30 --out <path>` with exit codes, so scripts and
  agents can drive it. The sidecar already gives them a machine-readable result.
- Per-app audio through WASAPI process loopback; needs native code.
