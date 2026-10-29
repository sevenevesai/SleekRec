# Instant replay

Keeps the last 30 s to 10 min of a GPU source on disk and saves it on demand, the feature gamers
expect from ShadowPlay and Game Bar. Code: `electron/replay-buffer.ts`; lifecycle in
`src/App.tsx` (`armReplay`, `disarmReplay`) and `electron/main.ts` (`replay-*` channels).

## Mechanism

One continuous `CaptureProcess` (the same graph, encoder and PCM pipe as a recording) writes
two-second Matroska segments with FFmpeg's segment muxer into
`<output folder>/.sleekrec-replay/<session>/seg-NNNNNN.mkv`, with `-reset_timestamps 1` and a
CSV segment list that FFmpeg appends (`name,start,end`) as each segment closes. Replay uses a
1 s GOP so segments close within about a second of their target.

SleekRec, not `-segment_wrap`, owns retention. It reads the list every 500 ms (serialized, so no
line is parsed twice) and deletes segments older than the replay length plus a 6 s margin. A
wrapping ring would overwrite the oldest file in place while a save might still be reading it,
and hard links would not protect against that truncation.

## Saving

A save notes the index of the segment being written, which holds the moment of the request, and
waits for it to close (at most a few seconds). It then takes segments back from that one until
they cover the replay length, pins them against pruning, and joins them with the concat demuxer
using each segment's explicit `duration` from the list. Explicit durations keep the original
timeline at every boundary; probed durations would leave a gap where audio outlasts video. The
join stream-copies into `Recording_<stamp>_<id>_replay.mp4` (MKV for Ultra) with `+faststart`,
reads the packets once more through a `framecrc` output for the sidecar's pacing statistics, and
verifies the duration within 2%. Saves are independent: two quick presses give overlapping clips.

Feedback comes from a toast window (`toast.html`): always on top, click-through and excluded from
capture. Windows suppresses notifications during fullscreen games, so replay does not use them.

## Bounds and lifecycle

- Disk: replay length plus the margin, times the bitrate; the 512 MB free-space floor disarms
  replay with a visible error.
- Turning replay off stops FFmpeg with `q` while PCM still flows, waits for pending saves, then
  deletes the session folder. Main keeps routing audio to a stopping buffer until FFmpeg exits.
- On startup SleekRec deletes leftover folders under `.sleekrec-replay` only; segments are not
  masters. The recordings panel ignores that folder.
- Starting a recording turns replay off for its duration and turns it back on, on the same
  source, after the save: the two would otherwise compete for one desktop duplication and encoder.
- "Turn on instant replay when SleekRec starts" arms the remembered source after the first source
  refresh. GPU sources only; the browser engine has no segment ring.

## Alternatives not taken

- Recording while armed by pinning segments from "now" (no gap, pre-roll possible): pause would
  only work at segment boundaries and the well-tested stop path would fork. Revisit if users ask
  for pre-roll on recordings.
- A browser-engine ring of MediaRecorder timeslices: WebM timeslices are not independently
  decodable without the first cluster's headers.

## Verification

`npm test` runs a real replay buffer on this machine's GPU: it saves after 7 s, checks that the
clip covers the buffered span, that the save waited at most for the current segment, that
timestamps are monotonic, and that stopping deletes the ring. The smoke test arms replay by
hotkey on a remembered region and saves it through the app.
