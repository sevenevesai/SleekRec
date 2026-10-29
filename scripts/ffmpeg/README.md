# Trimmed Windows FFmpeg

`vendor/ffmpeg/win32-x64/ffmpeg.exe` is FFmpeg n6.1.1 built with only the components SleekRec and
its tests use. It replaces ffmpeg-static's 82.8 MB gyan.dev 6.1.1 build in the Windows package;
macOS and Linux still use ffmpeg-static. `electron/ffmpeg.ts` resolves it, and
`docs/recording.md` holds the 6.1.1 behaviour the capture code relies on.

## Current binary

| | |
|---|---|
| Size | 13,795,328 bytes |
| SHA256 | `af98a7f65a3c466b7086054e48f52f53e3f6fca82b0d01a04cf49ddba59db4f9` |
| `ffmpeg -version` | `ffmpeg version n6.1.1-sleekrec`, built with gcc 16.2.0 (Rev6, Built by MSYS2 project) |
| License | GPL version 2 or later (libx264); notices in `vendor/ffmpeg/win32-x64/LICENSE.txt` |

When you rebuild, update this table, then rerun the gates below before committing the binary.

## Sources

Pinned in `build-ffmpeg-win.sh`; each fetch is checked against the commit or SHA256.

| Source | Pin | Reason |
|---|---|---|
| FFmpeg | tag `n6.1.1`, `e38092ef93` | Same commit as the shipped gyan.dev build; newer versions change capture timing |
| x264 | r3172 `c1c9931dc8`, on the stable branch | Same x264 core as the shipped build (CPU export fallback) |
| nv-codec-headers | `75f032b242` (n12.1.14.0-1) | Same NVENC headers as the shipped build |
| libvpx | `v1.14.1` | Encodes a test fixture only; closest release to the shipped 1.13.1-601 |
| opus | 1.6.1 tarball, SHA256 `6ffcb593…72411a1` | Encodes a test fixture only; latest release |
| AMF headers | 1.4.36 release tarball, SHA256 `ec07ee21…dd87564` | AMD capture and export; the runtime ships in AMD's driver. Last 1.4.x |
| libvpl | `v2.15.0`, `c45b5d786b` | Intel Quick Sync dispatcher; the runtime ships in Intel's driver |

### Patches

`scripts/ffmpeg/patches/*.patch` apply to the pinned tree in name order; each header explains
why. They change only paths that SleekRec's default-adapter NVENC capture did not use.

| Patch | Fixes |
|---|---|
| `0001-amfenc-accept-bgra-input` | AMF refused ddagrab's BGRA frames ("Format of input frames context (bgra) is not supported") |
| `0002-d3d11va-explicit-adapter-from-dxgi-1.1-factory` | `-init_hw_device d3d11va=<index>` devices failed Desktop Duplication ("Invalid output duplication argument") |
| `0003-ddagrab-fixed-frame-pool-for-qsv` | QSV maps only fixed frame pools; `ddagrab=...:extra_hw_frames=N` now fixes the pool |

The libvpl build also rewrites two files in place, both in the script: an MSVC-only shim in
`mfx_dispatcher_defs.h` that breaks mingw-w64 14's `stralign.h` (an undefined `_MSC_VER`
compares as 0), and `vpl.pc`, which must name `-lstdc++` for FFmpeg's C link of the static C++
dispatcher.

Decoding uses FFmpeg's native VP9 and Opus decoders, as in the shipped build, so libvpx and
libopus are built encoder-only. Media Foundation needs no download: mingw-w64 has its headers and
Windows ships the runtime.

## Toolchain

MSYS2 base `2026-09-27` in the MINGW64 environment. MINGW64 links msvcrt like the gyan.dev
build; UCRT64 would change the C runtime. Versions after `pacman -Syuu` on 2026-10-24:
msys2-runtime 3.6.11-4, gcc 16.2.0-6, binutils 2.47-4, mingw-w64 crt/headers/winpthreads
14.0.0.r532, nasm 3.02-1, pkgconf 3.0.10, make 4.4.1-3, git 2.56.0-1, diffutils 3.12-1, curl
8.23.0-1; for libvpl, cmake 4.4.4-4 and ninja 1.13.2-1 (installed 2026-10-29). MSYS2 is a
rolling release, so a later install gets newer compilers; record the versions here when the
binary changes.

## Install MSYS2 portably

No PATH or registry changes; everything stays under `S:\tools\msys64`. In PowerShell:

```powershell
mkdir S:\tools\msys2-download; cd S:\tools\msys2-download
S:\tools\gh\bin\gh.exe release download 2026-09-27 -R msys2/msys2-installer -p 'msys2-base-x86_64-20260927.sfx.exe*'
Get-Content msys2-base-x86_64-20260927.sfx.exe.sha256; (Get-FileHash msys2-base-x86_64-20260927.sfx.exe).Hash  # must match: ad336ccc…
.\msys2-base-x86_64-20260927.sfx.exe -y -oS:\tools   # creates S:\tools\msys64
$env:MSYSTEM = 'MINGW64'; $env:CHERE_INVOKING = '1'
S:\tools\msys64\usr\bin\bash.exe -lc 'pacman -Syuu --noconfirm'   # twice: the first run updates the core
S:\tools\msys64\usr\bin\bash.exe -lc 'pacman -S --needed --noconfirm mingw-w64-x86_64-gcc mingw-w64-x86_64-binutils mingw-w64-x86_64-nasm mingw-w64-x86_64-pkgconf mingw-w64-x86_64-cmake mingw-w64-x86_64-ninja make git diffutils'
S:\tools\msys64\usr\bin\bash.exe -lc 'gcc --version'   # success: gcc.exe (Rev6, Built by MSYS2 project) 16.2.0, or newer
```

- HTTP 429 from a mirror fails the transaction; rerun pacman.
- `mingw-w64-x86_64-yasm` no longer exists; nasm covers FFmpeg, x264 and libvpx.
- PowerShell 5.1 re-quotes native arguments, so bash commands containing quotes or parentheses
  break; put them in a script file and run `bash.exe -l <file>`.

## Build

```powershell
$env:MSYSTEM = 'MINGW64'; $env:CHERE_INVOKING = '1'
S:\tools\msys64\usr\bin\bash.exe -lc '/s/SleekRec/scripts/ffmpeg/build-ffmpeg-win.sh'
```

Success: the last lines print the SHA256, the byte size and `ffmpeg version n6.1.1-sleekrec`.
The script writes `vendor/ffmpeg/win32-x64/ffmpeg.exe` and `LICENSE.txt` (GPLv2 plus the libvpx,
opus and nv-codec-headers notices). Sources and objects go to `.test-output/ffmpeg-build`, or to
`FFMPEG_BUILD_DIR`. Dependencies are cached per pin; after changing a dependency's configure
flags, run with `--clean`, which rebuilds everything (about 5 minutes on the 2026-10-24 machine).

The output is byte-for-byte reproducible with the same toolchain: builds in
`.test-output/ffmpeg-build` and `S:/tools/ffmpeg-repro-check` (2026-10-29) gave the SHA256 above.
Four things keep it that way. FFmpeg builds in-tree, so `__FILE__` strings stay relative. libvpx
gets no `--prefix`, because it embeds its configure arguments. libvpl builds out of tree with
`-ffile-prefix-map`. `SOURCE_DATE_EPOCH` is pinned, because `strip` otherwise writes the current
time into the PE header. A different gcc or binutils changes the bytes, not the components.

## Configure line

```
--pkg-config=pkgconf --pkg-config-flags=--static --extra-version=sleekrec --enable-gpl --enable-static --disable-shared --extra-ldflags=-static --disable-autodetect --disable-w32threads --disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-postproc --disable-everything --enable-d3d11va --enable-ffnvcodec --enable-nvenc --enable-amf --enable-libvpl --enable-mediafoundation --enable-libx264 --enable-libvpx --enable-libopus --enable-indev=lavfi --enable-protocol='file,pipe' --enable-demuxer='matroska,mov,concat' --enable-muxer='matroska,webm,mp4,mov,null,framecrc,hash,pcm_f32le,segment,rawvideo' --enable-decoder='h264,hevc,vp8,vp9,opus,aac,ffv1,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le' --enable-encoder='h264_nvenc,hevc_nvenc,h264_amf,hevc_amf,h264_qsv,hevc_qsv,h264_mf,hevc_mf,libx264,aac,libopus,libvpx_vp9,ffv1,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le' --enable-parser='h264,hevc,aac,opus,vp8,vp9' --enable-bsf='h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,null' --enable-filter='ddagrab,color,testsrc,testsrc2,sine,select,settb,setpts,asetpts,aresample,aformat,format,scale,fps,null,anull,trim,atrim,hwupload,hwdownload,hwmap,vpp_qsv'
```

`--disable-w32threads` matches the shipped build's threading (static winpthreads). Configure
also pulls in what these select (for example `cuda`, `vp9_superframe_split`, `hflip`/`transpose`
for the CLI's autorotate).

## Components and their users

| Components | Used by |
|---|---|
| `ddagrab` (needs d3d11va), `select`, `settb`, NVENC, AMF, QSV and MF H.264/HEVC encoders, `hwmap`, `vpp_qsv`, `hwdownload` | Native capture, `electron/gpu-capture.ts` |
| `segment` muxer | Instant replay's segment ring, `electron/replay-buffer.ts` |
| `rawvideo` muxer | Thumbnails and scrub frames as raw BGRA over a pipe |
| `fps` filter | Fit-to-size exports |
| `hwupload` | Kept for GPU encoder experiments without a display |
| lavfi indev | Test fixtures and the export encoder probe |
| matroska demuxer, `pcm_f32le` decoder, `aresample`, `asetpts`, `aac` encoder | Live PCM audio, `electron/pcm-matroska.ts` |
| matroska/webm/mp4/mov muxers, matroska/mov/concat demuxers | Masters, segment join, remux, MP4 export |
| h264, hevc, vp8, vp9, opus, aac decoders and parsers; bitstream filters | Remux/export inputs, stream probing, muxer-inserted filters |
| `libx264` | CPU export fallback, test fixtures |
| `framecrc`, `null`, `hash`, `pcm_f32le` muxers | Pacing statistics, probes, tests |
| `rawvideo`, `wrapped_avframe`, `pcm_s16le` | lavfi device packets and the default codecs of the hash/null sinks |
| `format`, `aformat`, `scale`, `null`, `anull`, `trim`, `atrim`, `setpts` | Inserted by the ffmpeg CLI for `-pix_fmt`, `-ac`/`-ar` and `-t` |
| `libvpx_vp9`, `libopus`, `ffv1`, `color`, `testsrc`, `testsrc2`, `sine` | Test fixtures (`color` is also the NVENC probe) |

## Adding a component

A missing component fails as FFmpeg error text from `runFfmpeg`, for example `Unknown encoder`,
`No such filter` or `Unknown input format`. Add it to `config` in `build-ffmpeg-win.sh`, rebuild,
and rerun the gates. Configure names differ from CLI names (`libvpx-vp9` is `libvpx_vp9`, the
`f32le` muxer is `pcm_f32le`), and configure silently ignores unknown names, so check the
`Enabled …` lists it prints.

## Packaging

`package.json` `win.extraResources` copies `ffmpeg.exe` and `LICENSE.txt` (as
`ffmpeg-LICENSE.txt`) into `resources/`. `win.files` excludes `node_modules/ffmpeg-static/**` and
repeats the root `files` patterns: with only the negation, electron-builder 24.13.3 packed the
whole repository into a 392 MB `app.asar`. A correct build has no `ffmpeg-static` under
`dist_app/win-unpacked` and `resources/ffmpeg.exe` with the SHA256 above.

## Gates

With `node_modules/ffmpeg-static/ffmpeg.exe` renamed away, so only this binary can run:
`npm test` (22 pass), `npm run test:recording` (`SMOKE PASS`; it prints the resolved binary),
`npm run build:win`, then a real capture through `dist_app/win-unpacked/SleekRec.exe` with a
custom `--user-data-dir`, checked with `ffmpeg -i <file> -f null -` and a `framecrc` packet count.
