# September 2026 stutter investigation

## Supplied recording

`Recording_2026-09-17T19-32-32-227Z_ca1bb38a.mp4` was recorded in 1.1.1. The user selected a
monitor and reported steady 165 fps gameplay. The sidecar identifies browser H.264, a 60 fps
target and initial track dimensions of 2560x1440. Encoded packets instead show:

| Measurement | Result |
|---|---|
| Saved dimensions | 2560x1398 |
| Frames | 16,454 |
| Mean packet rate | 23.27 fps |
| Median / p95 / p99 frame interval | 42 / 49 / 115 ms |
| Intervals over 100 ms | 188 |
| Longest interval | 297 ms |

These gaps exist in the file; playback alone does not explain the report. The installed helper
and current Electron/DXGI mapping correctly identify the 2560x1440/165 display on the RTX 2080 Ti.
The original sidecar lacks the source ID/name, so the unexpected browser route is unresolved.
Do not infer that the user selected a window. Capture source provenance in subsequent reports;
Automatic Windows screen capture now fails visibly when GPU mapping is unavailable.

## Validation limits

The unit suite verifies packet timing, saved dimensions, pause boundaries, lossless YUV 4:4:4
sample identity through Ultra H.264/HEVC, and preservation through export. The hardware smoke
test verifies system audio, stop, pause/resume and strictly increasing packet timestamps.

Synthetic desktop measurements varied with whether the test window was actually visible to
desktop duplication; they do not establish a gameplay performance improvement. Before claiming
the stutter is fixed or 165 unique frames/s is sustained, repeat moving gameplay and inspect both
the footage and sidecar. Follow the longer gameplay/audio checks in [recording.md](recording.md).
Ultra preserves YUV samples after color conversion; it does not promise bit-identical RGB.
