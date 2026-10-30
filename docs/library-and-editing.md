# Recordings panel, trim and export

The Recordings tab lists what SleekRec saved and is where every edit starts. Code:
`electron/library.ts` (listing, path guard, recovery; no Electron imports, so it is unit-tested),
`electron/export-recording.ts` (export, fit-to-size, trim, keyframes, frame grabs),
`src/RecordingsPanel.tsx`, `src/TrimEditor.tsx`, and the handlers in `electron/main.ts`.

## Listing

`listLibrary` reads the output folder only, newest first: files named `Recording_*.mp4|mkv|webm`,
with kind and details from the `.json` sidecar when present (engine, encoder, size, delivered
fps, gaps over 100 ms, audio tracks, save warnings), else from the name (`_replay`, `_trim`,
`_fit-NMB`, `_export`, `_compatible`). Session folders that still hold `part-NNN.mkv` and browser
`.partial.mkv|webm` files list as unfinished. FFmpeg's own `.partial.mp4` outputs and the replay
directory are skipped.

`libraryPath` guards every IPC call that names a file: it must resolve directly inside the output
folder and look like a recording (a session folder only where the action allows it). The media
protocol and the trash, copy, export and trim handlers all go through it.

Thumbnails and probe facts load when a card scrolls into view (`media-details`), two at a time.
The trimmed FFmpeg has no image encoder, so the keyframe at or before 10% of the duration is
decoded to raw BGRA over a pipe (`grabFrame`, `rawvideo` muxer) and turned into a JPEG with
`nativeImage`. The result is cached in `userData/thumbnails`, keyed by path, size and modification
time; cached cards skip the two-at-a-time queue. Keep `-fps_mode passthrough` in `grabFrame`: without
it FFmpeg's frame-rate sync discards frames before the seek point, so `-noaccurate_seek` and
`-skip_frame nokey` stop returning the earlier keyframe and scrubbing near the end finds no frame.

After a UI-started stop the panel opens with the new file outlined. Hotkey stops stay in the game
and show a toast. Explorer is no longer opened on every save; Show in folder is a card action.

## Actions

- **Play** opens the default player. **Delete** moves the file and its sidecar to the recycle bin
  after a confirming second click.
- **Copy** puts the file on the clipboard as CF_HDROP with a copy drop effect (helper
  `--copy-files`), what Explorer does, so it pastes into Discord, chat apps and folders. Cards are
  also draggable out of the window (`webContents.startDrag`).
- **Recover** on an unfinished entry joins the parts (or remuxes a browser partial) into
  `_recovered.mkv|mp4`, tolerating a cut last cluster, then moves the originals to the recycle
  bin, so they stay restorable. It refuses a finished recording, which the move would discard. A
  failed move becomes a warning on the recovered file. A session folder whose `.mp4`/`.mkv` already exists holds parts a
  save could not delete: it lists as leftover parts with Delete only.

Exports, trims and recoveries run one at a time as jobs with progress and Cancel (an
`AbortSignal` kills FFmpeg). They are refused during a recording but allowed while instant replay
is armed, which can run for hours. Every job, recovery included, writes `<name>.partial.<ext>`
(`writeNew`), renames it only on success, never overwrites (`uniqueOutput` adds `-2`, `-3`) and
writes a sidecar naming the source and the operation.

## Export

- **MP4, same video** copies H.264/HEVC packets (HEVC tagged `hvc1`) with every audio track.
- **Compatible H.264 MP4** re-encodes at the source resolution and timing with the first export
  encoder that initializes from system memory (NVENC, AMF, QSV, Media Foundation, then x264).
- **Fit under 10/25/50/100/500 MB** (`fitPlan`, `fitToSize`) budgets 96% of the target for
  container overhead and rate-control error, gives audio 64-160 kb/s, and picks the largest
  size and frame rate that keep about 0.045 bits per pixel. It drops to 30 fps before going
  below 720p, since a sharp 30 fps clip reads better than a smeared 60 fps one. Too little
  bitrate fails with advice to trim. The `fps` filter makes output constant-rate, so B-frames
  are safe here, unlike in live capture. Hardware VBR is checked against the target and
  re-encoded at a proportionally lower bitrate on an overshoot, up to three attempts;
  without hardware, two-pass x264. Only the default (mixed) audio track is kept.

## Trim

The editor previews through the `sleekrec-media://` scheme: privileged, streaming, and serving
HTTP range requests from disk so `<video>` can seek without reading the whole master. The page
CSP allows it as `media-src`. Chromium cannot decode H.264 4:4:4 (Ultra), so those masters, and
anything whose `<video>` fails, scrub through decoded keyframes (`media-frame`) instead.

- **Fast** stream-copies from the keyframe at or before the in point (`keyframeTimes` reads
  keyframe packets with `-discard:v nokey`). The handle snaps there and the editor shows the
  difference, so the saved trim starts where it shows. Same container as the source, every track.
- **Exact** re-encodes from the exact frame to compatible H.264 MP4 at QP/CRF 18 with every audio
  track as AAC.

Keyboard: Space plays the selection, I and O set the points, arrows step a frame (Shift a second),
Esc closes. Smart rendering (re-encode only the first GOP, copy the rest) was not taken: FFmpeg's
MP4 muxer cannot carry two parameter sets for one stream.
