# Spec: encoder choice, automatic compression, large-file MKV, start/stop hotkey

Written 2026-11-10 against 1.3.0. Four requested features, compared with what the code already
does. Nothing here is implemented yet. Each section lists the current state, the change, the
rules that must hold, and the tests. Decisions that need the owner are collected at the end.

Shared rules for all four: settings go through `src/recording.ts` (type), `electron/main.ts`
(default) and `electron/settings.ts` (validation) together; masters and failed parts are never
replaced or deleted by a new code path; `npx tsc --noEmit` and `npm test` pass after each.

## 1. Encoder selection (NVENC, AMF, Quick Sync)

**Today.** Automatic. `familiesFor` in `electron/gpu-capture.ts` maps the vendor of the adapter
that owns the display to one hardware family, then Media Foundation. `probeAdapter` records the
first family that initializes per codec. The user picks only `nativeCodec` (`h264` or `hevc`).
Exports pick independently through `bestExportEncoder` (NVENC, AMF, QSV, MF, x264, first that
works).

**Constraint that shapes the feature.** ddagrab's frames are textures on the display's adapter and
the encoder reads them there without a copy. On one display the only valid families are that
adapter's own and `mf`. NVENC cannot encode a display driven by an Intel GPU without downloading
every frame to system memory. A free three-way choice does not exist on the zero-copy path.

**Change, phase 1.**
- New setting `encoderPreference: 'auto' | EncoderFamily`, default `auto`.
- `probeAdapter` probes every family in `familiesFor`, not just the first success, so
  `NativeDisplay.encoders` becomes `Partial<Record<NativeCodec, EncoderFamily[]>>` in preference
  order. Probes still run two frames each and stay cached per adapter LUID.
- Selection at start: the preferred family when the display's adapter offers it for the chosen
  codec, else the first available. The source card and the sidecar name the family actually
  used. When the preference could not be honoured the card says why, for example "NVENC is not
  on the GPU driving Display 2; using Quick Sync".
- Settings shows one row per adapter with its available families, and the preference dropdown
  lists only families some adapter offers, plus Auto.
- `bestExportEncoder` tries the preferred family first. Add `x264` as an explicit export choice;
  it gives the best quality per byte and is otherwise reachable only on machines with no GPU
  encoder.
- Ultra stays NVENC-only (`captureEngineForSource`); a non-NVENC preference with Ultra is refused
  with the existing error.

**Phase 2, only with measurements.** Cross-adapter encoding for hybrid laptops: panel on the
iGPU, encode on the idle dGPU, through `hwdownload` and an upload. It costs a copy per frame (the
MF path measured about 145 fps at 1440p this way). Offer it only if a run on an Optimus laptop
shows the iGPU encoder missing its frame rate while the copy path holds it.

**Rules.** Never switch family inside a recording: parts with different codec parameters cannot
be stream-copied into one file. An encoder that fails mid-recording keeps its parts, reports,
and drops the cached probe for that adapter so the next start re-probes. A selectable family is
a probed family; AMF and QSV remain "built, unverified on hardware" (`roadmap.md` item 2) and
the UI must not call them tested.

**Not included.** AV1 (`av1_nvenc`, `av1_amf`, `av1_qsv`): needs the encoders in the trimmed
FFmpeg build, a third `NativeCodec`, and editor-compatibility checks. Separate item.

**Tests.** Unit: selection given a probe result and a preference (honoured, unavailable, Ultra).
Unit: export encoder order with a preference. Smoke: `npm run test:recording` with preference
`mf` on the NVIDIA machine, asserting the sidecar names `h264_mf`.

## 2. Configurable post-recording compression

**Today.** Manual only, from the Recordings panel. `exportRecording(..., 'small')` re-encodes to
H.264 at a fixed QP 24, source resolution and timing. `fitToSize` takes one of
`fitTargetsMB` (10, 25, 50, 100, 500). No setting changes codec, quality, resolution or frame
rate, and nothing runs by itself after a stop.

**Change.**
- A `CompressionOptions` value: `codec` (`h264` | `hevc`), `quality` (`high` | `balanced` |
  `small`, mapping to QP 20 / 24 / 28; x264 CRF one lower, as now), `maxHeight` (`source` | 1440 |
  1080 | 720), `maxFps` (`source` | 60 | 30). `balanced`, `h264`, `source`, `source` reproduces
  today's Compatible MP4 exactly.
- `ExportRequest` gains a `compress` mode carrying those options; `small` stays as its preset.
  The panel's export menu gets a "Compress…" entry with the four controls, pre-filled from
  settings. Fit-to-size accepts any whole target from 5 to 4000 MB besides the presets.
- New settings: `afterRecording: 'none' | 'compress' | 'fit'` (default `none`),
  `compression: CompressionOptions`, `fitTargetMB: number`.
- When `afterRecording` is not `none`, a successful finalize enqueues the job on the existing
  job queue (one at a time, progress, Cancel). Output is a new file, `_compressed` or
  `_fit-NMB`, with a sidecar naming its source. A toast reports the result with both sizes.
- The output is verified before it is reported: video stream present and duration within 1% of
  the master, the check `finalizeCapture` already applies.

**Rules.**
- The master is kept, so automatic compression adds a file and frees no space; see the open
  decision below.
- Jobs are refused during a recording today. An automatic job must wait instead: starting a
  recording aborts a running automatic job and requeues it for after the stop, because a second
  encoder session competes with live capture. Manual jobs keep the current refusal.
- Automatic jobs do not run for replay saves unless a later setting says so; clips are short and
  usually shared with fit-to-size by hand.
- HEVC output is tagged `hvc1` and labelled as less compatible; fit-to-size stays H.264.
- A failed or cancelled automatic job leaves the master untouched and shows a toast with the
  first error line. It is not retried silently.

**Tests.** Unit: argument building per encoder for each option combination, including the
scale and fps filters. Unit: settings validation and defaults. Unit: queue behaviour (enqueue
on finalize, abort and requeue when a recording starts, no job for `none`). Manual: a 1440p
master compressed with each quality level, sizes recorded in the commit message.

## 3. Automatic MKV for large recordings

**Today.** Capture always writes Matroska parts. On stop `finalizeCapture` stream-copies them to
a faststart MP4, verifies packet count and duration, then deletes the parts. It keeps the MKV
when free space is below the parts' size plus 512 MiB, when the copy or verification fails, or
when the preset is Ultra. There is no size threshold. Faststart writes the file and then
rewrites it to move the index to the front, so stop takes roughly two full passes over the
recording. That time has not been measured for large files.

**Change.**
- New setting `mp4MaxGB: 0 | 4 | 8 | 16 | 32 | 64` where 0 means "always MP4". A recording whose
  parts total more than the limit is saved as MKV. Proposed default 16; see open decisions.
- Implementation point: the `mp4:` option passed from `CaptureProcess` to `finalizeCapture`
  (`electron/native-recorder.ts`) becomes false above the limit. A single-part recording is then
  a rename and stop returns at once; a multi-part one is one copy, not two.
- This is a chosen outcome, not a failure: the result carries a note ("Saved as MKV: 38 GB is
  over the 16 GB MP4 limit"), separate from `warning`, and the toast and card show it without
  warning styling.
- While recording, once the written size passes the limit the overlay shows "will save as MKV".
- The card's existing "MP4, same video" export converts later. It must check free space before
  starting, as finalize does, and say how much is needed.

**Rules.** The existing fallbacks stay and take precedence in their own cases. No path deletes
parts before a verified output exists. Replay saves are bounded and unaffected.

**Alternative worth choosing between.** Above the limit, write MP4 without faststart: one pass
instead of two, and the file still opens in editors that refuse MKV (the reason roadmap item 3
exists). It is less robust than MKV only during the copy, which the kept parts already cover.
MKV is what was asked for and is specified above; the non-faststart MP4 is a one-flag variation.

**Unknowns to measure first.** Finalize throughput in GB per minute on an SSD and an HDD, which
sets the default. Behaviour at 4 GB on FAT32 and exFAT output folders, where the parts
themselves may hit a file-size limit.

**Tests.** Unit: `finalizeCapture` with parts above and below the limit (extension, note, parts
removed, nothing overwritten). Unit: settings validation. Manual: one recording past the limit,
stop-to-saved time recorded for MKV and for MP4.

## 4. Global start/stop hotkey

**Today: built.** `Ctrl+Shift+F8` starts or stops the remembered source, with separate stop,
pause, replay-save and replay-toggle actions, all rebindable in Settings
(`hotkeys-and-tray.md`). Registration uses Electron `globalShortcut`. A combination held by
another app shows "In use by another app" and a toast. Hotkey starts toast instead of raising
the window.

**Gaps.**
- Unverified in exclusive-fullscreen games and with an elevated game in the foreground. Run the
  matrix: borderless, exclusive fullscreen, elevated game, anti-cheat title; record whether the
  hotkey fires, the toast shows, and the capture survives the mode switch. Only if registration
  proves unreliable there, add a low-level keyboard hook in the helper as a second path; do not
  add it speculatively, since hooks are what anti-cheat flags.
- With no remembered source, or one that no longer matches, the window opens, which pulls the
  player out of the game. Proposed setting `hotkeySource: 'last' | 'activeDisplay'`: the second
  records the display holding the foreground window. Default stays `last`, keeping the rule that
  a hotkey never silently picks a different source.
- Optional start and stop sound cue for cases where the toast is not visible; off by default
  and never routed into the recording.

**Tests.** Unit: `hotkeySource` resolution. The fullscreen matrix is manual and its results go
into `hotkeys-and-tray.md`.

## Open decisions

1. Compression and the master: keep both files always (current contract in `CLAUDE.md`), or add
   an opt-in "move the master to the Recycle Bin after a verified compressed copy". The second
   changes a written project rule.
2. Large recordings: MKV as specified, or MP4 without faststart, and the default limit (16 GB
   proposed, to be replaced by a measured figure).
3. Whether `hotkeySource: 'activeDisplay'` is wanted at all.
4. Whether AV1 and cross-adapter encoding go on the roadmap.

## Order and size

3 is the smallest (one option, one setting, one note). 1 phase 1 touches the probe type and its
consumers. 2 is the largest because of the queue rule. 4 is mostly a test run. Suggested order:
3, 1, 2, with the hotkey matrix run alongside on real games.
