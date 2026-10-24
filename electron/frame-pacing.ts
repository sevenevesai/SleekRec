import { FramePacing } from '../src/recording'

// Fixed-size histogram: monitoring a long recording must not retain every frame.
// These are encoded packet intervals, not a count of unique desktop updates.
export class FramePacingMeter {
  private histogram = new Uint32Array(1001)
  private frames = 0
  private intervals = 0
  private elapsedMs = 0
  private previous?: number
  private maxGapMs = 0
  private gapsOver50ms = 0
  private gapsOver100ms = 0
  private nonMonotonicTimestamps = 0
  private partial = ''
  private crcTimeBase = 0

  beginSegment(): void { this.previous = undefined }

  add(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) return
    this.frames++
    if (this.previous !== undefined) {
      const gap = milliseconds - this.previous
      if (gap <= 0) this.nonMonotonicTimestamps++
      else {
        this.intervals++
        this.elapsedMs += gap
        this.histogram[Math.min(1000, Math.ceil(gap - 0.0001))]++
        this.maxGapMs = Math.max(this.maxGapMs, gap)
        if (gap > 50.0001) this.gapsOver50ms++
        if (gap > 100.0001) this.gapsOver100ms++
      }
    }
    this.previous = milliseconds
  }

  line(line: string): boolean {
    const timeBase = /^#tb 0: (\d+)\/(\d+)/.exec(line)
    if (timeBase) { this.crcTimeBase = Number(timeBase[1]) * 1000 / Number(timeBase[2]); return true }
    if (/^0,/.test(line) && this.crcTimeBase) {
      this.add(Number(line.split(',')[2]) * this.crcTimeBase)
      return true
    }
    const match = /^sleek_pts=(-?\d+) (\d+)\/(\d+)\s*$/.exec(line)
    if (!match) return false
    if (Number(match[3])) this.add(Number(match[1]) * Number(match[2]) * 1000 / Number(match[3]))
    return true
  }

  write(data: Buffer): void {
    this.partial += data.toString()
    const lines = this.partial.split('\n')
    this.partial = (lines.pop() || '').slice(-1024)
    for (const line of lines) this.line(line)
  }

  snapshot(): FramePacing {
    let p95GapMs = 0
    let count = 0
    for (let ms = 0; ms < this.histogram.length; ms++) {
      count += this.histogram[ms]
      if (count >= Math.ceil(this.intervals * 0.95)) {
        p95GapMs = ms === 1000 ? Math.ceil(this.maxGapMs) : ms
        break
      }
    }
    return { frames: this.frames, averageFps: this.elapsedMs ? this.intervals * 1000 / this.elapsedMs : 0,
      p95GapMs, maxGapMs: this.maxGapMs, gapsOver50ms: this.gapsOver50ms,
      gapsOver100ms: this.gapsOver100ms, nonMonotonicTimestamps: this.nonMonotonicTimestamps }
  }
}

export const framePacingArgs = ['-stats_mux_pre:v', 'pipe:1', '-stats_mux_pre_fmt:v', 'sleek_pts={pts} {tb}']
