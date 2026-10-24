# SleekRec

Screen and window recorder with GPU capture for high-quality Windows recordings.

## Download

[seveneves.ai/sleekrec](https://seveneves.ai/sleekrec)

**Windows** — x64 installer
**macOS** — ARM64 / Intel DMG
**Linux** — AppImage / .deb

The Windows setup (.exe), the Linux AppImage, and Developer ID–signed macOS apps check GitHub
Releases at launch, download a newer version in the background, and install it when you quit.
Update MSI, .deb, and unsigned macOS installs by downloading the new release.

## Features

- Windows/NVIDIA screen recording at source resolution and a selected frame rate up to 240 fps
- H.264 or HEVC GPU encoding; Ultra preserves full color detail with lossless encoding after color conversion
- MKV masters written during recording, with quick finalization for uninterrupted recordings
- Separate MP4 export and compression that keep the master
- Browser recording for individual windows and other platforms
- Live GPU frame pacing and saved H.264 frame-gap statistics
- System audio, optional microphone, and microphone mute
- Pause and resume
- Quality presets (Low / Medium / High / Ultra)
- Always-on-top overlay during recording
- Configurable output folder

For 1440p gaming, choose **Ultra**, **Match display refresh**, and the screen marked **GPU capture**.
Keep Windows HDR off for this SDR capture path. The live display shows encoded fps separately
from the requested target. Sustained high-refresh capture depends on game/GPU load and disk
throughput; a 165 Hz display does not guarantee 165 recorded frames per second. Screens and windows
are listed separately. Automatic mode reports an error if it cannot match a Windows screen to GPU
capture; choose Browser explicitly to use that screen's slower recording path.

GPU capture currently supports unrotated displays on the default NVIDIA adapter. For games,
borderless fullscreen avoids display-mode switches. It records the visible screen, including
other windows. Fullscreen transitions or driver resets can interrupt capture.

Ultra records 4:4:4 color with lossless encoding after RGB-to-YUV conversion; it is not bit-identical
screen RGB. It needs a compatible player/editor, and file sizes can exceed several GB per minute.
Window/browser capture remains lossy. High keeps conventional 4:2:0 video for broader playback.
An uninterrupted GPU
recording saves by finalizing its MKV; paused segments require a stream-copy join. Use **MP4 · same
video quality** for H.264/HEVC remuxing or **Smaller MP4** to compress later. Both keep the source;
existing export files are never overwritten. VP9 browser recordings retain WebM until exported.

Stop: **Ctrl+Shift+F9**. Pause/resume: **Ctrl+Shift+F10**.

## Build

```
npm install
npm run dev
```

Windows development builds need Visual Studio C++ Build Tools with the Windows SDK to compile
the small display/recorder helper. `npm run dev` and Windows packaging build it automatically;
installed applications do not need these tools.

Production build:
```
npm run build:win
npm run build:mac
npm run build:linux
```

### macOS signing

CI signs the macOS app with a Developer ID and notarizes it when the repository has all five
Actions secrets below; with none of them it builds an unsigned app, and with only some the macOS
job fails. Pull request builds stay unsigned.

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12` | Base64 of the exported Developer ID Application certificate and key (`base64 -i cert.p12`) |
| `MACOS_CERTIFICATE_PASSWORD` | Password set when exporting that `.p12` |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key file (`AuthKey_<id>.p8`) |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the App Store Connect key list |

The in-app updater runs on macOS only when the installed app passes `codesign --verify` against
the Developer ID requirement, because Squirrel.Mac refuses updates for anything else.

Checks:
```
npx tsc --noEmit
npm test
npm run test:recording
```

The last command requires Windows and a supported NVIDIA display. It runs capture tests using
an isolated profile under `.test-output`. See [recording design and validation](docs/recording.md)
for engine contracts, recovery behavior and remaining gameplay/platform checks.

## Stack

Electron + React + TypeScript + Vite + Tailwind
FFmpeg for GPU capture, encoding and export; a small Windows helper for DXGI mapping and process cleanup.

## License

MIT — free for any use.
