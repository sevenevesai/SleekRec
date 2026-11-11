# Recordings panel, trim and export

The Recordings tab lists what SleekRec saved and is where every edit starts. Code:
`electron/library.ts` (listing, path guard, recovery; no Electron imports, so it is unit-tested),
`electron/export-recording.ts` (export, fit-to-size, trim, keyframes, frame grabs),
`src/RecordingsPanel.tsx`, `src/TrimEditor.tsx`, and the handlers in `electron/main.ts`.

## Listing

`listLibrary` reads the output folder only, newest first: files named `Recording_*.mp4|mkv|webm`,
with kind and details from the `.json` sidecar when present (engine, encoder, size, delivered
fps, gaps over 100 ms, audio tracks, save warnings), else from the name (`_replay`, `_trim`,
`_fit-NMB`, `_export`, `_compatible`, `_compressed`). Session folders that still hold
`part-NNN.mkv` and browser `.partial.mkv|webm` files list as unfinished. FFmpeg's own `.partial.mp4` outputs and the replay
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
`AbortSignal` kills FFmpeg), through `JobQueue` in `electron/job-queue.ts` (no Electron imports,
unit-tested). They are refused during a recording and while another job runs, but allowed while
instant replay is armed, which can run for hours. Every job, recovery included, writes
`<name>.partial.<ext>` (`writeNew`), renames it only on success, never overwrites (`uniqueOutput`
adds `-2`, `-3`) and writes a sidecar naming the source and the operation. Exports and trims
first check the output drive (`ensureFreeSpace`): the estimate (the input for a copy, its share
of the kept span for a trim, the target for a fit, the input scaled by the pixels per second kept
for a compression) plus 512 MiB, as finalize keeps, or they fail and say how much is needed.

## Export

- **MP4, same video** copies H.264/HEVC packets (HEVC tagged `hvc1`) with every audio track.
- **Compatible H.264 MP4** re-encodes at the source resolution and timing with the first export
  encoder that initializes from system memory (NVENC, AMF, QSV, Media Foundation, then x264).
  The family chosen in Settings (`encoderPreference`) is tried first for every export and trim.
  It is the compress mode with `defaultCompression` and produces the same file as before it.
- **Compress…** (`compressRecording`) opens a form pre-filled from Settings: codec, quality
  (constant QP 20/24/28, x264 CRF one lower), at most 1440p/1080p/720p, at most 60/30 fps.
  Each cap applies only where the source exceeds it: scaling keeps the aspect with even sides,
  and the `fps` filter makes the output constant-rate; otherwise the timing is the source's.
  Every audio track is kept. HEVC is tagged `hvc1` and needs a hardware encoder that
  initializes (`hevcExportEncoder`; the trimmed FFmpeg has no software HEVC); without one the
  job fails and asks for H.264, never switching codec itself. Output `_compressed.mp4`.
- **Fit under 10/25/50/100/500 MB**, or any whole size from 5 to 4000 MB typed below them
  (checked in the field and again by `parseExportRequest` in main). `fitPlan` and `fitToSize`
  budget 96% of the target for container overhead and rate-control error, give audio
  64-160 kb/s, and pick the largest size and frame rate that keep about 0.045 bits per pixel. It drops to 30 fps before going
  below 720p, since a sharp 30 fps clip reads better than a smeared 60 fps one. Too little
  bitrate fails with advice to trim. The `fps` filter makes output constant-rate, so B-frames
  are safe here, unlike in live capture. Hardware VBR is checked against the target and
  re-encoded at a proportionally lower bitrate on an overshoot, up to three attempts;
  without hardware, two-pass x264. Only the default (mixed) audio track is kept.

Compressed and fitted copies are verified before they take their name (`verifyCopy`): a video
stream and the master's duration within 1% (at least 1 s), the check finalize applies. A master
whose container states no duration is checked for video only.

## After recording

Settings > After recording can make a copy of each saved recording by itself: a compression with
the saved options, or a fit under the saved size. `automaticRequest` decides; replay saves and
unfinished partials never queue one. The stop handlers enqueue after the save result exists,
outside the recorders' stop sequence. Each job is a normal export: `_compressed` or `_fit-NMB`,
verified, with a sidecar, then a toast with both sizes ("Compressed 2.1 GB to 310 MB").

Queue rules, in `JobQueue`:
- One job at a time, shared with manual jobs. A manual job is refused while an automatic one
  runs ("cancel it or wait"); recordings are still refused during a manual job.
- An automatic job never blocks a recording, because a second encoder session competes with
  live capture. `claimRecording` marks the recording busy, then `yieldToRecording` aborts the
  job, waits until FFmpeg has exited and its partial is removed, and puts it back at the front.
  Pending jobs start only when no recording is busy, after each stop and after each job.
- Instant replay neither waits for nor stops an automatic job: arming is refused only during a
  manual job, and jobs already run beside an armed replay.
- Cancel ends the running job for good. A failed job is not retried. Both show a toast with
  the first error line and say the original is kept.
- The queue is in memory. Quitting or closing the window (when it does not hide to the tray)
  cancels a running automatic job, waits for FFmpeg to exit, drops pending ones without a toast
  and quits; nothing resumes on the next start, and the masters are untouched. A manual job
  still holds the quit until it ends, as before.

**Recycle opt-in.** `recycleMasterAfterCompress` is off by default and shown only with a mode
chosen. `recycleMasterAfterCopy` (in `library.ts`, Electron-free) is the only code that removes a
master: automatic jobs only, the setting read when the copy is done, and the copy verified again
against the master right before the move, including being smaller (a short or already efficient
master can compress into a larger file). The master and its sidecar go to the Recycle Bin
(`shell.trashItem`), so they stay restorable. A refused check or a failed move keeps the master
and becomes a warning on the copy's card and in the toast. Manual exports never touch the master.

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
