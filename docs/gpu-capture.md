# GPU capture

How the native engine captures on the adapter that owns a display, which encoder it uses there,
and how areas and window areas crop. Engine selection, audio, stop ordering and finalize are in
[recording.md](recording.md).

## Adapters and encoders

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
screen RGB, and needs a player/editor that accepts 4:4:4. Ultra stays MKV ([recording.md](recording.md)).

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

## Checking a capture

Count packets with `ffmpeg -i <file> -map 0 -c copy -f framecrc -` and check that DTS strictly
increases per stream; the smoke test does this. `ffmpeg -i <file> -f null -` on a variable-rate
MP4 prints "non monotonically increasing dts to muxer" warnings without a fault in the file:
FFmpeg guesses a frame rate (330 fps on the test machine) from the sub-3 ms catch-up intervals and
rescales decoded frames onto that coarser grid. It still decodes every frame and exits 0.

References: [FFmpeg ddagrab](https://ffmpeg.org/ffmpeg-filters.html#ddagrab),
[NVENC rate control](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html),
[DXGI DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput).
