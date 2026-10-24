import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { ffmpegBinary, runFfmpeg } from './ffmpeg'
import { AppSettings, CaptureInfo, NativeDisplay, PCMChunk, RecordingStats, SavedRecording, qualityPresets, requestedFps } from '../src/recording'
import { pcmHeader, pcmPacket, pcmAudioFilter } from './pcm-matroska'
import { FramePacingMeter, framePacingArgs } from './frame-pacing'

export function listNativeDisplays(helper: string): Promise<NativeDisplay[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise(resolve => {
    execFile(helper, [], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([])
      try { resolve(JSON.parse(stdout)) } catch { resolve([]) }
    })
  })
}

export function locateNativeWindows(helper: string, sourceIds: string[]): Promise<{
  handle: string; x: number; y: number
}[]> {
  const handles = sourceIds.map(id => /^window:(\d+):/.exec(id)?.[1]).filter((id): id is string => !!id)
  if (process.platform !== 'win32' || !handles.length) return Promise.resolve([])
  return new Promise(resolve => {
    execFile(helper, ['--windows', ...handles], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([])
      try { resolve(JSON.parse(stdout)) } catch { resolve([]) }
    })
  })
}

export function nativeVideoArgs(display: NativeDisplay, settings: AppSettings): string[] {
  const fps = requestedFps(settings.frameRate, display.refreshRate)
  return [
    // The bundled FFmpeg 6.1 uses a legacy DXGI factory for explicit adapter
    // indices. Its lavfi device is implicit; accept only the verified default
    // adapter, never pretend an adapter option selects a different GPU.
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${display.output}:framerate=${fps}:draw_mouse=1:output_fmt=bgra`,
  ]
}

export function nativeEncoderArgs(settings: AppSettings, fps: number): string[] {
  const ultra = settings.qualityPreset === 'ultra'
  // Leave RGB-to-YUV color signaling to NVENC. Its BGRA conversion uses a
  // BT.601 matrix; overriding the tags to BT.709 changes decoded colors.
  return ['-c:v', settings.nativeCodec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc',
    '-preset', ultra ? 'p1' : 'p4', '-tune', ultra ? 'lossless' : 'hq',
    '-rc', 'constqp', '-qp', String(qualityPresets[settings.qualityPreset].qp),
    '-rgb_mode', ultra ? 'yuv444' : 'yuv420', '-multipass', 'disabled',
    // Two frames in flight overlap capture and encoding. Delay zero forces a
    // synchronous bitstream wait for each frame despite allocating 8 surfaces.
    '-b:v', '0', '-rc-lookahead', '0', '-bf', '0', '-surfaces', '8', '-delay', '2', '-g', String(fps * 2),
    '-profile:v', settings.nativeCodec === 'hevc' ? (ultra ? 'rext' : 'main') : (ultra ? 'high444p' : 'high'),
    // Drop sub-millisecond catch-up frames before quantization. Pass through
    // the remaining capture timestamps without FFmpeg's frame rescheduling.
    '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.001)',settb=1/1000",
    '-fps_mode', 'passthrough', '-enc_time_base', '1:1000']
}

type Segment = {
  file: string
  child: ChildProcessWithoutNullStreams
  server?: net.Server
  socket?: net.Socket
  pendingAudio: PCMChunk[]
  pendingBytes: number
  audioOrigin: number
  ready: Promise<void>
  done: Promise<void>
  stopping: boolean
  stop?: Promise<void>
  stats: RecordingStats
}

export class NativeRecorder {
  readonly id = randomUUID()
  readonly info: CaptureInfo
  readonly folder: string
  private segment?: Segment
  private parts: string[] = []
  private completedSeconds = 0
  private completedFrames = 0
  private completedBytes = 0
  private closed = false
  private lastStats?: RecordingStats
  private stopPromise?: Promise<SavedRecording>
  private pacing = new FramePacingMeter()

  constructor(private display: NativeDisplay, private settings: AppSettings,
    private onStats: (stats: RecordingStats) => void, private onError: (message: string) => void,
    private launcher?: string) {
    this.info = { engine: 'native', codec: `${settings.nativeCodec.toUpperCase()} / NVIDIA NVENC`,
      width: display.width, height: display.height, targetFps: requestedFps(settings.frameRate, display.refreshRate),
      quality: settings.qualityPreset === 'ultra' ? 'lossless-444' : 'lossy-420' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.folder = path.join(settings.outputFolder, `Recording_${stamp}_${this.id.slice(0, 8)}`)
  }

  async startSegment(): Promise<void> {
    if (this.closed || this.segment) throw new Error('Recording is already active or closed')
    if (!this.display.nvidia || !this.display.defaultAdapter || this.display.rotation > 1) {
      throw new Error('Native recording needs a landscape display on the default NVIDIA adapter.')
    }
    await fs.mkdir(this.folder, { recursive: true })
    this.pacing.beginSegment()
    const file = path.join(this.folder, `part-${String(this.parts.length + 1).padStart(3, '0')}.mkv`)
    const hasAudio = this.settings.systemAudio || this.settings.micEnabled
    const preset = qualityPresets[this.settings.qualityPreset]
    const pipeName = `\\\\.\\pipe\\sleekrec-${randomUUID()}`
    let server: net.Server | undefined
    let segment: Segment | undefined
    if (hasAudio) {
      server = net.createServer(socket => {
        if (!segment || segment.socket) { socket.destroy(); return }
        segment.socket = socket
        // FFmpeg opens this pipe immediately after initializing the video input.
        segment.audioOrigin = performance.timeOrigin + performance.now()
        const header = pcmHeader(preset.audioSampleRate, preset.audioChannels)
        socket.write(header)
        socket.on('error', error => { if (!segment?.stopping) this.onError(`Audio pipe: ${error.message}`) })
        for (const chunk of segment.pendingAudio) {
          const packet = this.audioPacket(chunk, segment.audioOrigin)
          if (packet) socket.write(packet)
        }
        segment.pendingAudio = []
        segment.pendingBytes = 0
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(pipeName, () => { server!.removeListener('error', reject); resolve() })
      })
    }
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1', '-progress', 'pipe:1', '-n',
      ...nativeVideoArgs(this.display, this.settings),
      ...(hasAudio ? ['-thread_queue_size', '64', '-probesize', '32', '-analyzeduration', '0',
        '-seekable', '0', '-f', 'matroska', '-i', pipeName] : []),
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', preset.audioBitrate,
        '-af', pcmAudioFilter] : ['-an']),
      ...nativeEncoderArgs(this.settings, this.info.targetFps),
      ...framePacingArgs,
      '-max_interleave_delta', '1000000', '-cluster_time_limit', '1000', '-flush_packets', '1', '-f', 'matroska', file]
    const child = this.launcher
      ? spawn(this.launcher, ['--run', String(process.pid), ffmpegBinary, ...args], { windowsHide: true })
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
    segment = { file, child, server, pendingAudio: [], pendingBytes: 0, audioOrigin: 0, ready, done, stopping: false,
      stats: { frames: 0, fps: 0, seconds: 0, bytes: 0, speed: 0 } }
    this.segment = segment
    this.parts.push(file)
    const active = segment
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
        if (!active.stopping) this.onError('GPU capture ended unexpectedly. The recording parts have been kept.')
      } else {
        const error = new Error(`GPU capture failed (${code}). ${log.slice(-2500)}\nRecording parts: ${this.folder}`)
        rejectReady(error); rejectDone(error)
        if (!active.stopping) this.onError(error.message)
      }
    })
    let partial = ''
    let values: Record<string, string> = {}
    let lastFrames = 0
    let lastTime = performance.now()
    child.stdout.on('data', data => {
      partial += data.toString()
      const lines = partial.split('\n')
      partial = lines.pop() || ''
      for (const line of lines) {
        if (this.pacing.line(line)) continue
        const split = line.indexOf('=')
        if (split < 0) continue
        const key = line.slice(0, split)
        values[key] = line.slice(split + 1).trim()
        if (key !== 'progress') continue
        const now = performance.now()
        const frames = Number(values.frame) || 0
        const seconds = Math.max(0, (Number(values.out_time_us) || 0) / 1_000_000)
        const fps = (frames - lastFrames) * 1000 / Math.max(1, now - lastTime)
        active.stats = { frames, seconds, fps, bytes: Number(values.total_size) || 0,
          speed: parseFloat(values.speed) || 0 }
        if (frames > 0) { clearTimeout(timer); resolveReady() }
        this.lastStats = { ...active.stats, seconds: seconds + this.completedSeconds,
          frames: frames + this.completedFrames, bytes: active.stats.bytes + this.completedBytes,
          pacing: this.pacing.snapshot(),
          ...(seconds > 8 && fps < this.info.targetFps * 0.85 ? {
            warning: 'Encoding below the requested frame rate. Static screens also produce fewer frames; check moving gameplay.'
          } : {}) }
        this.onStats(this.lastStats)
        lastFrames = frames
        lastTime = now
        values = {}
      }
    })
  }

  waitUntilReady(): Promise<void> {
    if (!this.segment) return Promise.reject(new Error('No active GPU capture'))
    return this.segment.ready
  }

  private audioPacket(chunk: PCMChunk, origin: number): Buffer | null {
    const preset = qualityPresets[this.settings.qualityPreset]
    const skip = Math.max(0, Math.ceil((origin - chunk.capturedAt) * preset.audioSampleRate / 1000))
    const offset = skip * preset.audioChannels * 4
    if (offset >= chunk.data.byteLength) return null
    const milliseconds = chunk.capturedAt + skip * 1000 / preset.audioSampleRate - origin
    const packet = pcmPacket(milliseconds, Buffer.from(chunk.data).subarray(offset))
    return packet
  }

  async writeAudio(chunk: PCMChunk): Promise<void> {
    const active = this.segment
    if (!active || active.child.exitCode !== null) return
    if (!(chunk.data instanceof ArrayBuffer) || chunk.data.byteLength > 384_000 || !Number.isFinite(chunk.capturedAt)) {
      throw new Error('Invalid audio packet')
    }
    if (!active.socket) {
      if (active.pendingBytes + chunk.data.byteLength > 2_000_000) throw new Error('Audio is waiting too long for the GPU recorder')
      active.pendingAudio.push(chunk)
      active.pendingBytes += chunk.data.byteLength
      return
    }
    const buffer = this.audioPacket(chunk, active.audioOrigin)
    if (!buffer) return
    if (active.socket.destroyed || active.socket.writableEnded) {
      if (active.stopping) return
      throw new Error('The recording audio pipe closed unexpectedly')
    }
    await new Promise<void>((resolve, reject) => active.socket!.write(buffer, error => {
      if (error && !active.stopping) reject(error)
      else resolve()
    }))
  }

  pause(): Promise<void> {
    const active = this.segment
    if (!active) return Promise.resolve()
    if (!active.stop) active.stop = this.finishSegment(active)
    return active.stop
  }

  private async finishSegment(active: Segment): Promise<void> {
    active.stopping = true
    // Keep the PCM input alive until FFmpeg consumes q and drains its encoders.
    active.child.stdin.write('q\n')
    const timeout = setTimeout(() => active.child.kill(), 10000)
    try {
      await active.done
      this.completedFrames += active.stats.frames
      this.completedSeconds += active.stats.seconds
      this.completedBytes += active.stats.bytes
    } finally {
      clearTimeout(timeout)
      active.socket?.destroy()
      active.server?.close()
      this.segment = undefined
    }
  }

  stop(): Promise<SavedRecording> {
    if (!this.stopPromise) this.stopPromise = this.finish()
    return this.stopPromise
  }

  private async finish(): Promise<SavedRecording> {
    this.closed = true
    await this.pause()
    if (!this.parts.length) throw new Error('No recording was captured')
    const output = `${this.folder}.mkv`
    if (this.parts.length === 1) {
      await fs.rename(this.parts[0], output)
    } else {
      const manifest = path.join(this.folder, 'parts.ffconcat')
      await fs.writeFile(manifest, 'ffconcat version 1.0\n' +
        this.parts.map(file => `file '${path.basename(file)}'`).join('\n') + '\n')
      await runFfmpeg(['-n', '-f', 'concat', '-safe', '1', '-i', manifest, '-map', '0', '-c', 'copy', output])
      // Delete only this session's inputs, and only after the join succeeds.
      for (const file of this.parts) await fs.unlink(file)
      await fs.unlink(manifest)
    }
    await fs.rmdir(this.folder)
    const probe = await runFfmpeg(['-i', output, '-map', '0:v:0', '-c', 'copy', '-t', '0', '-f', 'null', '-'], 10000)
    const duration = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    if (this.lastStats && duration) {
      const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      this.lastStats = { ...this.lastStats, seconds,
        fps: this.completedFrames / Math.max(seconds, 0.001), bytes: (await fs.stat(output)).size,
        pacing: this.pacing.snapshot() }
    }
    const result = { path: output, info: this.info, stats: this.lastStats }
    await fs.writeFile(`${output}.json`, JSON.stringify(result, null, 2)).catch(() => {})
    return result
  }

  async abort(): Promise<void> {
    this.closed = true
    await this.pause().catch(() => {})
    // Partial recordings are deliberately retained after a capture/startup failure.
  }
}
