import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppSettings, CaptureInfo, SavedRecording, qualityPresets } from '../src/recording'
import { runFfmpeg } from './ffmpeg'
import { FramePacingMeter } from './frame-pacing'

export class BrowserRecorder {
  readonly id = randomUUID()
  private stream?: fs.WriteStream
  private error?: Error
  private pending = Promise.resolve()
  private closed = false
  private file: string
  private stopPromise?: Promise<SavedRecording>

  constructor(private settings: AppSettings, private info: CaptureInfo, private codec: 'h264' | 'vp9') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.file = path.join(settings.outputFolder, `Recording_${stamp}_${this.id.slice(0, 8)}.partial.${codec === 'h264' ? 'mkv' : 'webm'}`)
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.settings.outputFolder, { recursive: true })
    this.stream = fs.createWriteStream(this.file, { flags: 'wx' })
    this.stream.on('error', error => { this.error = error })
    await new Promise<void>((resolve, reject) => {
      this.stream!.once('open', () => resolve())
      this.stream!.once('error', reject)
    })
  }

  write(chunk: ArrayBuffer): Promise<void> {
    if (this.closed || !this.stream) return Promise.reject(new Error('The recording file is closed'))
    if (chunk.byteLength > 64 * 1024 * 1024) return Promise.reject(new Error('Recording chunk exceeds the 64 MB queue limit'))
    this.pending = this.pending.then(() => new Promise<void>((resolve, reject) => {
      if (this.error) { reject(this.error); return }
      this.stream!.write(Buffer.from(chunk), error => error ? reject(error) : resolve())
    }))
    return this.pending
  }

  async flush(): Promise<void> {
    await this.pending
    if (this.error) throw this.error
  }

  stop(): Promise<SavedRecording> {
    if (!this.stopPromise) this.stopPromise = this.finish()
    return this.stopPromise
  }

  private async finish(): Promise<SavedRecording> {
    this.closed = true
    await this.flush()
    await new Promise<void>((resolve, reject) => {
      this.stream!.once('error', reject)
      this.stream!.end(() => resolve())
    })
    const preset = qualityPresets[this.settings.qualityPreset]
    const output = this.file.replace(/\.partial\.(mkv|webm)$/, this.codec === 'h264' ? '.mp4' : '.webm')
    const pacing = new FramePacingMeter()
    if (this.codec === 'h264') {
      await runFfmpeg(['-n', '-i', this.file, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', preset.audioBitrate, '-ac', String(preset.audioChannels),
        '-ar', String(preset.audioSampleRate), '-movflags', '+faststart', output,
        // FFmpeg 6.1 does not emit stats_mux_pre for stream copy. Inspect the
        // same compressed packets during remux; no decoding or second read.
        '-map', '0:v:0', '-c:v', 'copy', '-f', 'framecrc', 'pipe:1'],
      0, data => pacing.write(data))
      await fsp.unlink(this.file)
    } else {
      // Preserve the captured VP9 master. H.264 conversion is an explicit export.
      await fsp.rename(this.file, output)
    }
    // Capture track settings can describe the monitor before the first window
    // frame arrives. Report the saved dimensions, not that initial estimate.
    const probe = await runFfmpeg(['-i', output, '-map', '0:v:0', '-c', 'copy', '-t', '0', '-f', 'null', '-'], 10000)
    const dimensions = probe.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/)
    const duration = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0
    const measured = pacing.snapshot()
    const info = { ...this.info, ...(dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : {}) }
    const stats = measured.frames ? { frames: measured.frames, seconds, fps: measured.averageFps,
      bytes: (await fsp.stat(output)).size, speed: 1, pacing: measured } : undefined
    const result = { path: output, info, stats }
    await fsp.writeFile(`${output}.json`, JSON.stringify(result, null, 2)).catch(() => {})
    return result
  }

  async abort(): Promise<void> {
    this.closed = true
    await this.pending.catch(() => {})
    this.stream?.destroy()
    // Keep the partial file for recovery instead of erasing recorded footage.
  }
}
