import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppSettings, CaptureInfo, PCMChunk, RecordingStats, SavedRecording } from '../src/recording'
import { CaptureProcess, CaptureTarget, captureInfo } from './native-recorder'
import { FramePacingMeter } from './frame-pacing'
import { audioTrackArgs } from './finalize'
import { runFfmpeg } from './ffmpeg'
import { probeMedia } from './media-probe'

/** Replay segments live here, beside the recordings, so saving never crosses volumes. */
export const REPLAY_DIRECTORY = '.sleekrec-replay'
const SEGMENT_SECONDS = 2
/** Segments kept beyond the replay length, so a save never races the pruning. */
const MARGIN_SECONDS = 6

interface Segment {
  index: number
  file: string
  start: number
  end: number
  pins: number
}

/** Deletes replay buffers left by a crash. Only this app's own buffer directory is touched. */
export async function removeStaleReplayBuffers(outputFolder: string, keep?: string): Promise<void> {
  const root = path.join(outputFolder, REPLAY_DIRECTORY)
  const entries = await fs.readdir(root).catch(() => [] as string[])
  for (const entry of entries) {
    if (path.join(root, entry) !== keep) await fs.rm(path.join(root, entry), { recursive: true, force: true })
  }
}

/**
 * Instant replay: one continuous GPU capture into short Matroska segments, with the newest
 * `replaySeconds` (plus a margin) kept on disk. A save waits for the segment that contains
 * the request to close, so the clip includes that moment, then stream-copies the covering
 * segments into one file. Saved segments are pinned until their join finishes.
 */
export class ReplayBuffer {
  readonly id = randomUUID()
  readonly info: CaptureInfo
  readonly folder: string
  private capture?: CaptureProcess
  private segments: Segment[] = []
  private completed = 0
  private listOffset = 0
  private listPartial = ''
  private poll?: ReturnType<typeof setInterval>
  private saves = new Set<Promise<unknown>>()
  private stopping?: Promise<void>
  private waiters: (() => void)[] = []
  private reading = Promise.resolve()

  constructor(private target: CaptureTarget, private settings: AppSettings,
    private onStatus: (bufferedSeconds: number) => void, private onError: (message: string) => void,
    private launcher?: string) {
    this.info = captureInfo(target, settings, 'replay')
    this.folder = path.join(settings.outputFolder, REPLAY_DIRECTORY, this.id.slice(0, 8))
  }

  private get listFile(): string { return path.join(this.folder, 'segments.csv') }

  async start(): Promise<void> {
    await fs.mkdir(this.folder, { recursive: true })
    await removeStaleReplayBuffers(this.settings.outputFolder, this.folder)
    this.capture = await CaptureProcess.start({ target: this.target, settings: this.settings,
      fps: this.info.targetFps, launcher: this.launcher, pacing: new FramePacingMeter(),
      // One-second GOPs let a segment close within about a second of its target length.
      gopSeconds: 1,
      output: ['-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'matroska',
        '-reset_timestamps', '1', '-segment_list', this.listFile, '-segment_list_type', 'csv',
        '-max_interleave_delta', '1000000', path.join(this.folder, 'seg-%06d.mkv')],
      onProgress: () => {},
      onUnexpectedExit: error => this.onError(error ? error.message : 'Instant replay stopped unexpectedly.'),
    })
    this.poll = setInterval(() => { void this.readList() }, 500)
  }

  waitUntilReady(): Promise<void> {
    return this.capture ? this.capture.ready : Promise.reject(new Error('Instant replay is not running'))
  }

  writeAudio(chunk: PCMChunk): Promise<void> {
    return this.capture ? this.capture.writeAudio(chunk) : Promise.resolve()
  }

  /** Serialized: concurrent reads would parse the same appended bytes twice. */
  private readList(): Promise<void> {
    this.reading = this.reading.then(() => this.readNewEntries()).catch(error => {
      this.onError(`Instant replay could not read its segment list: ${String(error)}`)
    })
    return this.reading
  }

  /** FFmpeg appends filename,start,end to the list as each segment closes. */
  private async readNewEntries(): Promise<void> {
    const handle = await fs.open(this.listFile, 'r').catch(() => undefined)
    if (!handle) return
    try {
      const { size } = await handle.stat()
      if (size <= this.listOffset) return
      const buffer = Buffer.alloc(size - this.listOffset)
      await handle.read(buffer, 0, buffer.length, this.listOffset)
      this.listOffset = size
      const lines = (this.listPartial + buffer.toString()).split(/\r?\n/)
      this.listPartial = lines.pop() || ''
      for (const line of lines) {
        const [name, start, end] = line.split(',')
        const index = Number(/(\d+)\.mkv$/.exec(name || '')?.[1])
        if (!Number.isInteger(index) || !Number.isFinite(Number(end))) continue
        this.segments.push({ index, file: path.join(this.folder, path.basename(name)), start: Number(start), end: Number(end), pins: 0 })
        this.completed = Math.max(this.completed, index + 1)
      }
    } finally {
      await handle.close()
    }
    await this.prune()
    this.waiters.splice(0).forEach(wake => wake())
    this.onStatus(this.bufferedSeconds())
  }

  private bufferedSeconds(): number {
    if (!this.segments.length) return 0
    return Math.min(this.settings.replaySeconds, this.segments[this.segments.length - 1].end - this.segments[0].start)
  }

  private async prune(): Promise<void> {
    const newest = this.segments[this.segments.length - 1]?.end ?? 0
    const keepAfter = newest - this.settings.replaySeconds - MARGIN_SECONDS
    const kept: Segment[] = []
    for (const segment of this.segments) {
      if (segment.end < keepAfter && !segment.pins) await fs.unlink(segment.file).catch(() => {}) // Gone already is fine.
      else kept.push(segment)
    }
    this.segments = kept
  }

  private async segmentsThrough(index: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.completed <= index) {
      if (Date.now() > deadline) throw new Error('The replay segment did not finish in time')
      await new Promise<void>(resolve => {
        this.waiters.push(resolve)
        setTimeout(resolve, 500)
      })
      if (!this.stopping) await this.readList()
    }
  }

  save(): Promise<SavedRecording> {
    const job = this.join()
    this.saves.add(job)
    void job.finally(() => this.saves.delete(job)).catch(() => {})
    return job
  }

  private async join(): Promise<SavedRecording> {
    if (!this.capture || this.stopping) throw new Error('Instant replay is not running')
    await this.readList()
    // The segment being written now holds the moment of the request; wait for it to close.
    const current = this.completed
    await this.segmentsThrough(current, SEGMENT_SECONDS * 4 * 1000 + 5000)
    const last = this.segments.findIndex(segment => segment.index === current)
    if (last < 0) throw new Error('The replay buffer has no footage yet')
    let first = last
    while (first > 0 && this.segments[last].end - this.segments[first].start < this.settings.replaySeconds) first--
    const chosen = this.segments.slice(first, last + 1)
    chosen.forEach(segment => segment.pins++)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = path.join(this.settings.outputFolder, `Recording_${stamp}_${randomUUID().slice(0, 8)}_replay`)
    const output = `${base}.${this.settings.qualityPreset === 'ultra' ? 'mkv' : 'mp4'}`
    const partial = `${base}.partial${path.extname(output)}`
    const manifest = path.join(this.folder, `save-${randomUUID().slice(0, 8)}.ffconcat`)
    try {
      // Explicit durations from the segment list keep the original timeline at each boundary.
      await fs.writeFile(manifest, 'ffconcat version 1.0\n' + chosen.map(segment =>
        `file '${path.basename(segment.file)}'\nduration ${(segment.end - segment.start).toFixed(6)}`).join('\n') + '\n')
      const pacing = new FramePacingMeter()
      await runFfmpeg(['-n', '-f', 'concat', '-safe', '1', '-i', manifest, '-map', '0', '-c', 'copy',
        ...(this.settings.nativeCodec === 'hevc' && output.endsWith('.mp4') ? ['-tag:v', 'hvc1'] : []),
        ...audioTrackArgs(this.info.audioTracks ?? []), ...(output.endsWith('.mp4') ? ['-movflags', '+faststart'] : []),
        partial, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', 'pipe:1'], 0, data => pacing.write(data))
      const probe = await probeMedia(partial)
      const expected = chosen.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      if (!probe.video || Math.abs(probe.seconds - expected) > Math.max(1, expected * 0.02)) {
        throw new Error(`The replay join produced ${probe.seconds.toFixed(1)} s instead of ${expected.toFixed(1)} s`)
      }
      await fs.rename(partial, output)
      const measured = pacing.snapshot()
      const stats: RecordingStats = { frames: measured.frames, seconds: probe.seconds, fps: measured.averageFps,
        bytes: (await fs.stat(output)).size, speed: 1, pacing: measured }
      const result: SavedRecording = { path: output, info: this.info, stats }
      await fs.writeFile(`${output}.json`, JSON.stringify(result, null, 2)).catch(() => {})
      return result
    } catch (error) {
      await fs.unlink(partial).catch(() => {}) // Only this save's own unfinished output.
      throw error
    } finally {
      await fs.unlink(manifest).catch(() => {})
      chosen.forEach(segment => segment.pins--)
    }
  }

  /** Stops capture, lets pending saves finish, then deletes the buffer. */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        await this.capture?.stop().catch(() => {}) // A capture that already failed has reported its error.
        await this.readList()
        clearInterval(this.poll)
        await Promise.allSettled([...this.saves])
        await fs.rm(this.folder, { recursive: true, force: true })
      })()
    }
    return this.stopping
  }
}
