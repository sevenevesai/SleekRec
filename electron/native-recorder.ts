import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { ffmpegBinary } from './ffmpeg'
import { AppSettings, CaptureInfo, CaptureRegion, EncoderFamily, NativeDisplay, PCMChunk, RecordingStats,
  SavedRecording, audioTrackTitles, encoderLabels, qualityPresets, requestedFps } from '../src/recording'
import { pcmHeader, pcmPacket, pcmAudioFilter } from './pcm-matroska'
import { FramePacingMeter, framePacingArgs } from './frame-pacing'
import { captureDeviceArgs, captureEncoderArgs, captureGraph, encoderName, openedExpectedAdapter } from './gpu-capture'
import { audioTrackArgs, finalizeCapture } from './finalize'
import { probeMedia } from './media-probe'

function runHelper<T>(helper: string, args: string[], fallback: T): Promise<T> {
  if (process.platform !== 'win32') return Promise.resolve(fallback)
  return new Promise(resolve => {
    execFile(helper, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(fallback)
      try { resolve(JSON.parse(stdout)) } catch { resolve(fallback) }
    })
  })
}

export function listNativeDisplays(helper: string): Promise<NativeDisplay[]> {
  return runHelper(helper, [], [])
}

export interface WindowLocation {
  handle: string
  /** Top-left of the window's monitor, physical pixels. */
  x: number
  y: number
  minimized: boolean
  window: CaptureRegion
}

export function locateNativeWindows(helper: string, sourceIds: string[]): Promise<WindowLocation[]> {
  const handles = sourceIds.map(id => /^window:(\d+):/.exec(id)?.[1]).filter((id): id is string => !!id)
  return handles.length ? runHelper(helper, ['--windows', ...handles], []) : Promise.resolve([])
}

export interface WindowRect extends CaptureRegion {
  handle: string
  title: string
}

/** Visible top-level windows, topmost first, excluding this app's windows. */
export function listWindowRects(helper: string): Promise<WindowRect[]> {
  return runHelper(helper, ['--window-rects', String(process.pid)], [])
}

export interface CaptureTarget {
  display: NativeDisplay
  family: EncoderFamily
  region?: CaptureRegion
}

export interface CaptureProgress {
  frames: number
  seconds: number
  bytes: number
  speed: number
}

export interface CaptureProcessOptions {
  target: CaptureTarget
  settings: AppSettings
  fps: number
  /** Output options and file: a Matroska part, or the replay buffer's segment muxer. */
  output: string[]
  gopSeconds?: number
  launcher?: string
  pacing: FramePacingMeter
  onProgress: (progress: CaptureProgress) => void
  /** Called when FFmpeg exits or the audio pipe fails without a stop; `error` is unset for a clean exit. */
  onUnexpectedExit: (error?: Error) => void
}

/**
 * One FFmpeg capture: ddagrab video on the GPU plus timestamped PCM over a named pipe.
 * `ready` resolves at the first encoded frame; stop sends q and waits for the drain.
 */
export class CaptureProcess {
  readonly ready: Promise<void>
  readonly done: Promise<void>
  stats: CaptureProgress = { frames: 0, seconds: 0, bytes: 0, speed: 0 }
  private stopping = false
  private stopPromise?: Promise<void>
  private socket?: net.Socket
  private pendingAudio: PCMChunk[] = []
  private pendingBytes = 0
  private audioOrigin = 0
  private readonly tracks: number

  private constructor(private child: ChildProcessWithoutNullStreams, private server: net.Server | undefined,
    private options: CaptureProcessOptions, ready: Promise<void>, done: Promise<void>) {
    this.ready = ready
    this.done = done
    this.tracks = audioTrackTitles(options.settings).length
  }

  static async start(options: CaptureProcessOptions): Promise<CaptureProcess> {
    const { target, settings, fps } = options
    const titles = audioTrackTitles(settings)
    const preset = qualityPresets[settings.qualityPreset]
    const pipeName = `\\\\.\\pipe\\sleekrec-${randomUUID()}`
    let capture: CaptureProcess | undefined
    let server: net.Server | undefined
    if (titles.length) {
      server = net.createServer(socket => {
        if (!capture || capture.socket) { socket.destroy(); return }
        capture.acceptAudio(socket)
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(pipeName, () => { server!.removeListener('error', reject); resolve() })
      })
    }
    const pixels = (target.region?.width ?? target.display.width) * (target.region?.height ?? target.display.height)
    // -loglevel info keeps FFmpeg's "Using device" line, which identifies the adapter it opened.
    const args = ['-hide_banner', '-loglevel', 'info', '-nostats', '-stats_period', '1', '-progress', 'pipe:1', '-n',
      ...captureDeviceArgs(target.display),
      ...(titles.length ? ['-thread_queue_size', '64', '-probesize', '32', '-analyzeduration', '0',
        '-seekable', '0', '-f', 'matroska', '-i', pipeName] : []),
      '-filter_complex', captureGraph({ display: target.display, family: target.family, fps, region: target.region }),
      '-map', '[v]',
      ...titles.flatMap((_, i) => ['-map', `0:a:${i}`]),
      ...(titles.length ? ['-c:a', 'aac', '-b:a', preset.audioBitrate, '-af', pcmAudioFilter, ...audioTrackArgs(titles)] : ['-an']),
      ...captureEncoderArgs(target.family, settings, fps, pixels * fps, options.gopSeconds),
      ...framePacingArgs, ...options.output]
    const child = options.launcher
      ? spawn(options.launcher, ['--run', String(process.pid), ffmpegBinary, ...args], { windowsHide: true })
      : spawn(ffmpegBinary, args, { windowsHide: true })
    let log = ''
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    // Errors may arrive before the renderer calls waitUntilReady.
    void ready.catch(() => {})
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    void done.catch(() => {})
    capture = new CaptureProcess(child, server, options, ready, done)
    const active = capture
    const timer = setTimeout(() => {
      rejectReady(new Error(`GPU capture did not start. ${log.slice(-1500)}`))
      child.kill()
    }, 15000)
    child.stdin.on('error', () => {})
    child.stderr.on('data', data => { log = (log + data.toString()).slice(-12000) })
    child.on('error', error => { rejectReady(error); rejectDone(error) })
    child.on('close', code => {
      clearTimeout(timer)
      active.socket?.destroy()
      active.server?.close()
      if (code === 0 && active.stats.frames > 0 && !/Error opening output file|Error writing|Conversion failed!|No space left on device/i.test(log)) {
        resolveReady(); resolveDone()
        if (!active.stopping) options.onUnexpectedExit()
      } else {
        const error = new Error(`GPU capture failed (${code}). ${log.slice(-2500)}`)
        rejectReady(error); rejectDone(error)
        if (!active.stopping) options.onUnexpectedExit(error)
      }
    })
    let partial = ''
    let values: Record<string, string> = {}
    let verified = false
    child.stdout.on('data', data => {
      partial += data.toString()
      const lines = partial.split('\n')
      partial = lines.pop() || ''
      for (const line of lines) {
        if (options.pacing.line(line)) continue
        const split = line.indexOf('=')
        if (split < 0) continue
        const key = line.slice(0, split)
        values[key] = line.slice(split + 1).trim()
        if (key !== 'progress') continue
        active.stats = { frames: Number(values.frame) || 0,
          seconds: Math.max(0, (Number(values.out_time_us) || 0) / 1_000_000),
          bytes: Number(values.total_size) || 0, speed: parseFloat(values.speed) || 0 }
        values = {}
        if (active.stats.frames > 0 && !verified) {
          clearTimeout(timer)
          // FFmpeg 6.1 opens the default adapter, without an error, when the index does not
          // resolve; refuse a capture that is not on the display's own adapter.
          if (!openedExpectedAdapter(log, target.display)) {
            rejectReady(new Error(`GPU capture opened a different adapter than ${target.display.adapterName}. Refresh the sources and try again.`))
            active.stopping = true
            child.kill()
            return
          }
          verified = true
          resolveReady()
        }
        options.onProgress(active.stats)
      }
    })
    return capture
  }

  private acceptAudio(socket: net.Socket): void {
    const preset = qualityPresets[this.options.settings.qualityPreset]
    this.socket = socket
    // FFmpeg opens this pipe immediately after initializing its inputs.
    this.audioOrigin = performance.timeOrigin + performance.now()
    socket.write(pcmHeader(preset.audioSampleRate, preset.audioChannels, this.tracks))
    socket.on('error', error => { if (!this.stopping) this.options.onUnexpectedExit(new Error(`Audio pipe: ${error.message}`)) })
    for (const chunk of this.pendingAudio) {
      const packet = this.audioPacket(chunk)
      if (packet) socket.write(packet)
    }
    this.pendingAudio = []
    this.pendingBytes = 0
  }

  private audioPacket(chunk: PCMChunk): Buffer | null {
    const preset = qualityPresets[this.options.settings.qualityPreset]
    const trackBytes = chunk.data.byteLength / this.tracks
    const skip = Math.max(0, Math.ceil((this.audioOrigin - chunk.capturedAt) * preset.audioSampleRate / 1000))
    const offset = skip * preset.audioChannels * 4
    if (offset >= trackBytes) return null
    const milliseconds = chunk.capturedAt + skip * 1000 / preset.audioSampleRate - this.audioOrigin
    const data = Buffer.from(chunk.data)
    return pcmPacket(milliseconds, Array.from({ length: this.tracks },
      (_, track) => data.subarray(track * trackBytes + offset, (track + 1) * trackBytes)))
  }

  async writeAudio(chunk: PCMChunk): Promise<void> {
    if (this.child.exitCode !== null || !this.tracks) return
    const frameBytes = this.tracks * qualityPresets[this.options.settings.qualityPreset].audioChannels * 4
    if (!(chunk.data instanceof ArrayBuffer) || chunk.data.byteLength > 384_000 || !Number.isFinite(chunk.capturedAt) ||
      (chunk.tracks ?? 1) !== this.tracks || chunk.data.byteLength % frameBytes) {
      throw new Error('Invalid audio packet')
    }
    if (!this.socket) {
      if (this.pendingBytes + chunk.data.byteLength > 2_000_000 * this.tracks) throw new Error('Audio is waiting too long for the GPU recorder')
      this.pendingAudio.push(chunk)
      this.pendingBytes += chunk.data.byteLength
      return
    }
    const buffer = this.audioPacket(chunk)
    if (!buffer) return
    const socket = this.socket
    if (socket.destroyed || socket.writableEnded) {
      if (this.stopping) return
      throw new Error('The recording audio pipe closed unexpectedly')
    }
    await new Promise<void>((resolve, reject) => socket.write(buffer, error => {
      if (error && !this.stopping) reject(error)
      else resolve()
    }))
  }

  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.finish()
    return this.stopPromise
  }

  private async finish(): Promise<void> {
    this.stopping = true
    // Keep the PCM input alive until FFmpeg consumes q and drains its encoders.
    this.child.stdin.write('q\n')
    const timeout = setTimeout(() => this.child.kill(), 10000)
    try {
      await this.done
    } finally {
      clearTimeout(timeout)
      this.socket?.destroy()
      this.server?.close()
    }
  }
}

export function captureInfo(target: CaptureTarget, settings: AppSettings, kind: CaptureInfo['kind'] = 'recording'): CaptureInfo {
  const titles = audioTrackTitles(settings)
  return { engine: 'native', kind,
    codec: `${settings.nativeCodec === 'hevc' ? 'HEVC' : 'H.264'} / ${encoderLabels[target.family]}`,
    encoder: encoderName(target.family, settings.nativeCodec), adapterName: target.display.adapterName,
    width: target.region?.width ?? target.display.width, height: target.region?.height ?? target.display.height,
    targetFps: requestedFps(settings.frameRate, target.display.refreshRate),
    quality: settings.qualityPreset === 'ultra' ? 'lossless-444' : 'lossy-420',
    ...(target.region ? { region: target.region } : {}), ...(titles.length ? { audioTracks: titles } : {}) }
}

export class NativeRecorder {
  readonly id = randomUUID()
  readonly info: CaptureInfo
  readonly folder: string
  private capture?: CaptureProcess
  private stopSegment?: Promise<void>
  private parts: string[] = []
  private completedSeconds = 0
  private completedFrames = 0
  private completedBytes = 0
  private closed = false
  private lastStats?: RecordingStats
  private stopPromise?: Promise<SavedRecording>
  private pacing = new FramePacingMeter()
  /** Encoded frames per part; a part whose FFmpeg never encoded (a failed resume) is not joined. */
  private partFrames = new Map<string, () => number>()

  constructor(private target: CaptureTarget, private settings: AppSettings,
    private onStats: (stats: RecordingStats) => void, private onError: (message: string) => void,
    private launcher?: string, private onFinalizeProgress?: (fraction: number) => void) {
    this.info = captureInfo(target, settings)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.folder = path.join(settings.outputFolder, `Recording_${stamp}_${this.id.slice(0, 8)}`)
  }

  async startSegment(): Promise<void> {
    if (this.closed || this.capture) throw new Error('Recording is already active or closed')
    await fs.mkdir(this.folder, { recursive: true })
    this.pacing.beginSegment()
    const file = path.join(this.folder, `part-${String(this.parts.length + 1).padStart(3, '0')}.mkv`)
    let lastFrames = 0
    let lastTime = performance.now()
    this.parts.push(file)
    const capture = await CaptureProcess.start({ target: this.target, settings: this.settings,
      fps: this.info.targetFps, launcher: this.launcher, pacing: this.pacing,
      output: ['-max_interleave_delta', '1000000', '-cluster_time_limit', '1000', '-flush_packets', '1', '-f', 'matroska', file],
      onProgress: progress => {
        const now = performance.now()
        const fps = (progress.frames - lastFrames) * 1000 / Math.max(1, now - lastTime)
        lastFrames = progress.frames
        lastTime = now
        this.lastStats = { fps, speed: progress.speed, seconds: progress.seconds + this.completedSeconds,
          frames: progress.frames + this.completedFrames, bytes: progress.bytes + this.completedBytes,
          pacing: this.pacing.snapshot(),
          ...(progress.seconds > 8 && fps < this.info.targetFps * 0.85 ? {
            warning: 'Encoding below the requested frame rate. Static screens also produce fewer frames; check moving gameplay.'
          } : {}) }
        this.onStats(this.lastStats)
      },
      onUnexpectedExit: error => this.onError(error
        ? `${error.message}\nRecording parts: ${this.folder}`
        : 'GPU capture ended unexpectedly. The recording parts have been kept.'),
    })
    this.capture = capture
    this.partFrames.set(file, () => capture.stats.frames)
    // An abort (renderer death) can land while FFmpeg is starting; it must not outlive the session.
    if (this.closed) {
      await this.pause().catch(() => {}) // The session is being abandoned; its error was already reported.
      throw new Error('The recording session ended while GPU capture was starting')
    }
  }

  waitUntilReady(): Promise<void> {
    if (!this.capture) return Promise.reject(new Error('No active GPU capture'))
    return this.capture.ready
  }

  writeAudio(chunk: PCMChunk): Promise<void> {
    return this.capture ? this.capture.writeAudio(chunk) : Promise.resolve()
  }

  pause(): Promise<void> {
    const active = this.capture
    if (!active) return Promise.resolve()
    if (!this.stopSegment) {
      // A segment that failed mid-way still holds footage up to its last cluster; count it too.
      this.stopSegment = active.stop().finally(() => {
        this.completedFrames += active.stats.frames
        this.completedSeconds += active.stats.seconds
        this.completedBytes += active.stats.bytes
        this.capture = undefined
        this.stopSegment = undefined
      })
    }
    return this.stopSegment
  }

  stop(): Promise<SavedRecording> {
    if (!this.stopPromise) this.stopPromise = this.finish()
    return this.stopPromise
  }

  private async finish(): Promise<SavedRecording> {
    this.closed = true
    // A failed last segment (a resume into exclusive fullscreen, a device loss) must not lose the
    // footage before it: keep every part that encoded frames and say what happened.
    const stopError = await this.pause().then(() => undefined, (error: unknown) => error)
    const parts = this.parts.filter(file => (this.partFrames.get(file)?.() ?? 0) > 0)
    if (!parts.length) throw stopError ?? new Error('No recording was captured')
    const finalized = await finalizeCapture(parts, this.folder, {
      mp4: this.settings.qualityPreset !== 'ultra', hevc: this.settings.nativeCodec === 'hevc',
      audioTracks: this.info.audioTracks ?? [], expectedFrames: this.pacing.snapshot().frames,
      expectedSeconds: this.completedSeconds, onProgress: this.onFinalizeProgress })
    const output = finalized.path
    const probe = await probeMedia(output).catch(() => undefined)
    if (this.lastStats && probe?.seconds) {
      this.lastStats = { ...this.lastStats, seconds: probe.seconds,
        fps: this.completedFrames / Math.max(probe.seconds, 0.001), bytes: (await fs.stat(output)).size,
        pacing: this.pacing.snapshot() }
    }
    const warnings = [stopError && `The last segment ended with an error, so the recording ends there: ${String(stopError).split('\n')[0].slice(0, 200)}`,
      finalized.warning].filter((text): text is string => !!text)
    const result: SavedRecording = { path: output, info: this.info, stats: this.lastStats,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
    await fs.writeFile(`${output}.json`, JSON.stringify(result, null, 2)).catch(() => {}) // Sidecar loss only costs panel details.
    return result
  }

  async abort(): Promise<void> {
    this.closed = true
    await this.pause().catch(() => {})
    // Partial recordings are deliberately retained after a capture/startup failure.
  }
}
