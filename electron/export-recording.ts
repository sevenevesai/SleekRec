import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CompressionOptions, NativeCodec, compressionQp, defaultCompression } from '../src/recording'
import { progressReader, runFfmpeg } from './ffmpeg'
import { MediaInfo, probeMedia } from './media-probe'

// Exports and trims never replace a master: each writes a new file through a .partial name
// and refuses an existing destination.

export type ExportEncoder = 'nvenc' | 'amf' | 'qsv' | 'mf' | 'x264'

const probeArgs: Record<Exclude<ExportEncoder, 'x264'>, string[]> = {
  nvenc: ['-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p'],
  amf: ['-c:v', 'h264_amf', '-pix_fmt', 'nv12'],
  qsv: ['-c:v', 'h264_qsv', '-pix_fmt', 'nv12'],
  mf: ['-c:v', 'h264_mf', '-hw_encoding', '1', '-pix_fmt', 'nv12'],
}

type HardwareEncoder = Exclude<ExportEncoder, 'x264'>
const exportEncoders = new Map<string, Promise<ExportEncoder>>()
/**
 * The first H.264 hardware encoder that really initializes from system-memory frames, trying
 * `preferred` before the rest. Use at least 256x144 for the probe: GPUs reject 64x64 and the
 * export would wrongly fall back to the CPU.
 */
export function bestExportEncoder(preferred?: HardwareEncoder): Promise<ExportEncoder> {
  if (process.platform !== 'win32') return Promise.resolve('x264')
  const key = preferred ?? 'auto'
  let result = exportEncoders.get(key)
  if (!result) {
    const families = Object.keys(probeArgs) as HardwareEncoder[]
    const order = preferred ? [preferred, ...families.filter(family => family !== preferred)] : families
    result = (async () => {
      for (const family of order) {
        try {
          await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=size=256x144', '-frames:v', '3', ...probeArgs[family],
            '-f', 'null', '-'], 10000)
          return family
        } catch { /* Not available on this machine; try the next family. */ }
      }
      return 'x264'
    })()
    exportEncoders.set(key, result)
  }
  return result
}

const hevcProbeArgs = (family: HardwareEncoder) => probeArgs[family].map(arg => arg.replace(/^h264_/, 'hevc_'))
const hevcEncoders = new Map<string, Promise<HardwareEncoder | undefined>>()
/**
 * The first HEVC hardware encoder that really initializes, `preferred` first. The trimmed FFmpeg
 * has no software HEVC encoder, so there may be none.
 */
export function hevcExportEncoder(preferred?: HardwareEncoder): Promise<HardwareEncoder | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined)
  const key = preferred ?? 'auto'
  let result = hevcEncoders.get(key)
  if (!result) {
    const families = Object.keys(probeArgs) as HardwareEncoder[]
    const order = preferred ? [preferred, ...families.filter(family => family !== preferred)] : families
    result = (async () => {
      for (const family of order) {
        try {
          await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=size=256x144', '-frames:v', '3', ...hevcProbeArgs(family),
            '-f', 'null', '-'], 10000)
          return family
        } catch { /* Not available on this machine; try the next family. */ }
      }
      return undefined
    })()
    hevcEncoders.set(key, result)
  }
  return result
}

/** Constant-quality H.264 or HEVC (tagged hvc1) at the frame timing of its input. x264 is H.264 only. */
function compatibleVideo(encoder: ExportEncoder, qp: number, codec: NativeCodec = 'h264'): string[] {
  const h264 = codec === 'h264'
  const tag = h264 ? [] : ['-tag:v', 'hvc1']
  switch (encoder) {
    case 'nvenc': return ['-c:v', `${codec}_nvenc`, '-preset', 'p5', '-rc', 'constqp', '-qp', String(qp), '-b:v', '0', '-bf', '0',
      '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-enc_time_base', '1:1000000', ...tag]
    case 'amf': return ['-c:v', `${codec}_amf`, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp),
      ...(h264 ? ['-qp_b', String(qp)] : []), '-bf', '0', '-pix_fmt', 'nv12', '-fps_mode', 'vfr', ...tag]
    case 'qsv': return ['-c:v', `${codec}_qsv`, '-preset', 'medium', '-q:v', String(qp), '-bf', '0', '-pix_fmt', 'nv12', '-fps_mode', 'vfr', ...tag]
    case 'mf': return ['-c:v', `${codec}_mf`, '-hw_encoding', '1', '-rate_control', 'quality', '-quality', String(Math.round(100 - qp * 1.2)),
      ...(h264 ? ['-profile:v', '100'] : []), '-bf', '0', '-pix_fmt', 'nv12', '-fps_mode', 'vfr', ...tag]
    case 'x264': return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(qp - 1), '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr']
  }
}

export interface JobOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  /** Tried first by the hardware encoder probe; the settings' `encoderPreference` when not auto. */
  preferredEncoder?: HardwareEncoder
}

export const partialPath = (output: string): string => output.replace(/(\.[^.\\/]+)$/, '.partial$1')

const exists = (file: string) => fs.access(file).then(() => true, () => false)

/** Writes through `.partial` and renames only on success; refuses an existing destination. */
export async function writeNew(output: string, write: (partial: string) => Promise<unknown>): Promise<void> {
  if (await exists(output)) throw new Error(`${output} already exists`)
  const partial = partialPath(output)
  // A stale partial is this function's own output from a crash; -n would otherwise refuse it.
  await fs.unlink(partial).catch(() => {})
  try {
    await write(partial)
    if (await exists(output)) throw new Error(`${output} already exists`)
    await fs.rename(partial, output)
  } catch (error) {
    await fs.unlink(partial).catch(() => {}) // Only this job's own unfinished output.
    throw error
  }
}

const progressArgs = (options: JobOptions) => options.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []

/** Every audio track, AAC copied and anything else converted, so separate tracks survive. */
function allAudio(info: MediaInfo, bitrate = '192k'): string[] {
  if (!info.audio.length) return []
  return ['-map', '0:a', ...info.audio.flatMap((stream, i) =>
    stream.codec === 'aac' ? [`-c:a:${i}`, 'copy'] : [`-c:a:${i}`, 'aac', `-b:a:${i}`, bitrate])]
}

const MiB = 1024 * 1024

/**
 * Refuses a write that would leave less than finalize's 512 MiB margin on the output's drive.
 * `bytes` is an estimate; a write that still fills the disk fails and removes its partial.
 */
export async function ensureFreeSpace(output: string, bytes: number): Promise<void> {
  const disk = await fs.statfs(path.dirname(output))
  const needed = bytes + 512 * MiB
  if (disk.bavail * disk.bsize < needed) {
    throw new Error(`Not enough disk space: this needs about ${(needed / 1024 / MiB).toFixed(1)} GB free in ${path.dirname(output)}.`)
  }
}

/**
 * A copy counts only with a video stream and the master's duration within 1% (at least 1 s), the
 * check finalize applies. A master whose container states no duration can only be checked for video.
 */
export async function verifyCopy(file: string, masterSeconds: number): Promise<void> {
  const probe = await probeMedia(file)
  if (!probe.video) throw new Error('The copy has no video stream')
  const tolerance = Math.max(1, masterSeconds * 0.01)
  if (masterSeconds > 0 && Math.abs(probe.seconds - masterSeconds) > tolerance) {
    throw new Error(`The copy lasts ${probe.seconds.toFixed(1)} s but the original ${masterSeconds.toFixed(1)} s`)
  }
}

/**
 * copy: the master's H.264/HEVC packets in MP4 with every audio track. small: a widely
 * compatible H.264 4:2:0 copy at the same resolution and frame timing (`defaultCompression`).
 */
export async function exportRecording(input: string, output: string, mode: 'copy' | 'small', options: JobOptions = {}): Promise<void> {
  if (mode === 'small') {
    await compressRecording(input, output, defaultCompression, options)
    return
  }
  const info = await probeMedia(input)
  const codec = info.video?.codec
  if (codec !== 'h264' && codec !== 'hevc') {
    throw new Error('This master needs H.264 conversion for MP4. Choose Compatible MP4; the original will be kept.')
  }
  await ensureFreeSpace(output, (await fs.stat(input)).size)
  await writeNew(output, partial => runFfmpeg(['-n', '-i', input, '-map', '0:v:0', '-c:v', 'copy', ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...allAudio(info), '-movflags', '+faststart', ...progressArgs(options), partial], 0,
  options.onProgress && progressReader(info.seconds, options.onProgress), options.signal))
}

export interface VideoShape {
  width?: number
  height?: number
  fps?: number
}

/** The caps that apply: each only when the source exceeds it. An unknown size or rate is left alone. */
function compressedShape(compression: CompressionOptions, source: VideoShape): { width?: number; height?: number; fps?: number } {
  const { maxHeight, maxFps } = compression
  const scale = maxHeight !== 'source' && source.width && source.height && source.height > maxHeight
  return {
    ...(scale ? { width: even(maxHeight * source.width! / source.height!), height: maxHeight } : {}),
    ...(maxFps !== 'source' && source.fps && Math.round(source.fps) > maxFps ? { fps: maxFps } : {}),
  }
}

/**
 * Video arguments for a compressed copy. Scaling keeps the aspect ratio with even sides. A frame
 * rate cap makes the output constant-rate through the fps filter; otherwise frame timing is the
 * source's, as in the Compatible MP4.
 */
export function compressVideoArgs(encoder: ExportEncoder, compression: CompressionOptions, source: VideoShape): string[] {
  const shape = compressedShape(compression, source)
  const filters = [...(shape.fps ? [`fps=${shape.fps}`] : []), ...(shape.height ? [`scale=${shape.width}:${shape.height}:flags=bicubic`] : [])]
  return [...(filters.length ? ['-vf', filters.join(',')] : []), ...compatibleVideo(encoder, compressionQp[compression.quality], compression.codec)]
}

export interface CompressResult {
  bytes: number
  encoder: ExportEncoder
  width?: number
  height?: number
  fps?: number
}

/**
 * A constant-quality copy with every audio track, scaled down or slowed only where the source
 * exceeds a cap, verified before it takes its name. HEVC never falls back to H.264: without a
 * working HEVC encoder this fails and says so.
 */
export async function compressRecording(input: string, output: string, compression: CompressionOptions,
  options: JobOptions = {}): Promise<CompressResult> {
  const info = await probeMedia(input)
  const encoder = compression.codec === 'hevc' ? await hevcExportEncoder(options.preferredEncoder)
    : await bestExportEncoder(options.preferredEncoder)
  if (!encoder) throw new Error('No HEVC encoder works on this PC. Choose H.264 to compress this recording.')
  const source = { width: info.video?.width, height: info.video?.height, fps: info.video?.fps }
  const shape = compressedShape(compression, source)
  // Bits at constant QP follow the pixels per second kept; a master already at or above the
  // chosen QP rarely grows, and ensureFreeSpace's margin covers the rest.
  const kept = (shape.height && source.height ? (shape.height / source.height) ** 2 : 1) * (shape.fps && source.fps ? shape.fps / source.fps : 1)
  await ensureFreeSpace(output, (await fs.stat(input)).size * kept)
  await writeNew(output, async partial => {
    await runFfmpeg(['-n', '-i', input, '-map', '0:v:0', ...compressVideoArgs(encoder, compression, source), ...allAudio(info),
      '-movflags', '+faststart', ...progressArgs(options), partial], 0,
    options.onProgress && progressReader(info.seconds, options.onProgress), options.signal)
    await verifyCopy(partial, info.seconds)
  })
  return { bytes: (await fs.stat(output)).size, encoder, width: shape.width ?? source.width, height: shape.height ?? source.height,
    fps: shape.fps ?? source.fps }
}

export interface FitPlan {
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

/**
 * Picks the largest size and frame rate whose bitrate still gives about 0.045 bits per pixel,
 * the point where H.264 gameplay and text stay legible. Frame rate drops to 30 before the
 * height goes below 720, since a sharp 30 fps clip reads better than a smeared 60 fps one.
 */
export function fitPlan(source: { seconds: number; width: number; height: number; fps: number }, targetBytes: number): FitPlan {
  const seconds = Math.max(0.1, source.seconds)
  let audioBitrate = targetBytes <= 10e6 ? 64_000 : targetBytes <= 25e6 ? 96_000 : targetBytes <= 100e6 ? 128_000 : 160_000
  // About 4% goes to container overhead and rate-control error.
  const budget = targetBytes * 8 * 0.96 / seconds
  let videoBitrate = budget - audioBitrate
  if (videoBitrate < 200_000 && audioBitrate > 48_000) { audioBitrate = 48_000; videoBitrate = budget - audioBitrate }
  if (videoBitrate < 100_000) {
    throw new Error(`This recording is too long for ${Math.round(targetBytes / 1e6)} MB: it would leave under 100 kb/s for video. Trim it first or choose a larger size.`)
  }
  const sourceFps = Math.max(1, Math.round(source.fps || 30))
  const high = Math.min(60, sourceFps)
  const low = Math.min(30, sourceFps)
  const heights = [source.height, 2160, 1440, 1080, 720, 540, 480, 360, 240]
    .filter((h, i, all) => h <= source.height && all.indexOf(h) === i)
  const sizes = heights.map(height => ({ height: even(height), width: even(height * source.width / source.height) }))
  const large = sizes.filter(size => size.height >= 720)
  const small = sizes.filter(size => size.height < 720)
  const candidates = [...large.map(size => ({ ...size, fps: high })), ...large.map(size => ({ ...size, fps: low })),
    ...small.map(size => ({ ...size, fps: large.length ? low : high })), ...small.map(size => ({ ...size, fps: low }))]
  const choice = candidates.find(c => videoBitrate / (c.width * c.height * c.fps) >= 0.045) ?? candidates[candidates.length - 1]
  return { ...choice, videoBitrate: Math.floor(videoBitrate), audioBitrate }
}

function fitVideo(encoder: ExportEncoder, bitrate: number): string[] {
  const b = String(bitrate)
  const max = String(Math.round(bitrate * 1.5))
  const buf = String(bitrate * 2)
  switch (encoder) {
    case 'nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres',
      '-b:v', b, '-maxrate', max, '-bufsize', buf, '-rc-lookahead', '32', '-spatial-aq', '1', '-bf', '2', '-pix_fmt', 'yuv420p']
    case 'amf': return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', b, '-maxrate', max, '-bufsize', buf,
      '-bf', '2', '-pix_fmt', 'nv12']
    case 'qsv': return ['-c:v', 'h264_qsv', '-preset', 'slow', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-bf', '2', '-pix_fmt', 'nv12']
    case 'mf': return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'pc_vbr', '-b:v', b, '-profile:v', '100', '-pix_fmt', 'nv12']
    // Both passes must encode the same frames, or x264 aborts with "Incomplete MB-tree stats file".
    // FFmpeg's automatic sync differs between the null and MP4 muxers; the fps filter already made it constant rate.
    case 'x264': return ['-c:v', 'libx264', '-preset', 'medium', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-pix_fmt', 'yuv420p',
      '-fps_mode', 'passthrough']
  }
}

export interface FitResult extends FitPlan {
  bytes: number
  encoder: ExportEncoder
  attempts: number
}

/**
 * Encodes a copy that fits under targetBytes, with the first (mixed) audio track. The frame
 * rate filter makes the output constant rate, so B-frames are safe here, unlike in live
 * capture. Hardware rate control lands within a few percent; an overshoot is re-encoded at a
 * proportionally lower bitrate, up to three attempts. Without a hardware encoder, two-pass
 * x264 hits the target, with one retry for safety.
 */
export async function fitToSize(input: string, output: string, targetBytes: number, options: JobOptions = {}): Promise<FitResult> {
  const info = await probeMedia(input)
  if (!info.video?.width || !info.video.height) throw new Error('The recording has no readable video stream')
  const plan = fitPlan({ seconds: info.seconds, width: info.video.width, height: info.video.height, fps: info.video.fps ?? 30 }, targetBytes)
  const encoder = await bestExportEncoder(options.preferredEncoder)
  await ensureFreeSpace(output, targetBytes)
  const filter = ['-vf', `fps=${plan.fps},scale=${plan.width}:${plan.height}:flags=bicubic`]
  const audio = info.audio.length ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', String(plan.audioBitrate), '-ac', '2'] : []
  const attemptsAllowed = encoder === 'x264' ? 2 : 3
  let bitrate = plan.videoBitrate
  let bytes = 0
  let attempts = 0
  await writeNew(output, async partial => {
    for (attempts = 1; attempts <= attemptsAllowed; attempts++) {
      const share = 1 / attemptsAllowed
      const report = (from: number, span: number) => options.onProgress &&
        progressReader(info.seconds, fraction => options.onProgress!(Math.min(0.99, (attempts - 1) * share + (from + fraction * span) * share)))
      if (encoder === 'x264') {
        const log = path.join(os.tmpdir(), `sleekrec-2pass-${randomUUID()}`)
        try {
          await runFfmpeg(['-y', '-i', input, '-map', '0:v:0', ...filter, ...fitVideo(encoder, bitrate), '-pass', '1',
            '-passlogfile', log, '-an', ...progressArgs(options), '-f', 'null', '-'], 0, report(0, 0.5), options.signal)
          await runFfmpeg(['-y', '-i', input, '-map', '0:v:0', ...filter, ...fitVideo(encoder, bitrate), '-pass', '2',
            '-passlogfile', log, ...audio, '-movflags', '+faststart', ...progressArgs(options), partial], 0, report(0.5, 0.5), options.signal)
        } finally {
          for (const file of await fs.readdir(os.tmpdir()).catch(() => [] as string[])) {
            if (file.startsWith(path.basename(log))) await fs.unlink(path.join(os.tmpdir(), file)).catch(() => {}) // Temp pass logs only.
          }
        }
      } else {
        await runFfmpeg(['-y', '-i', input, '-map', '0:v:0', ...filter, ...fitVideo(encoder, bitrate), ...audio,
          '-movflags', '+faststart', ...progressArgs(options), partial], 0, report(0, 1), options.signal)
      }
      bytes = (await fs.stat(partial)).size
      if (bytes <= targetBytes) {
        await verifyCopy(partial, info.seconds)
        return
      }
      const audioBytes = (info.audio.length ? plan.audioBitrate : 0) * info.seconds / 8
      bitrate = Math.floor(bitrate * Math.max(0.5, (targetBytes * 0.97 - audioBytes) / Math.max(1, bytes - audioBytes)))
    }
    throw new Error(`The encoder could not get under ${Math.round(targetBytes / 1e6)} MB (last try ${(bytes / 1e6).toFixed(1)} MB). Trim the recording or choose a larger size.`)
  })
  return { ...plan, videoBitrate: bitrate, bytes, encoder, attempts }
}

/** Keyframe times in seconds; a fast trim can start only on one of them. */
export async function keyframeTimes(input: string, signal?: AbortSignal): Promise<number[]> {
  let timeBase = 0
  let pending = ''
  const times: number[] = []
  // -discard nokey skips non-key packets in demuxers that support it; the flag check covers the rest.
  await runFfmpeg(['-discard:v', 'nokey', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', 'pipe:1'], 0, data => {
    const lines = (pending + data.toString()).split('\n')
    pending = lines.pop() || ''
    for (const line of lines) {
      const tb = /^#tb 0: (\d+)\/(\d+)/.exec(line)
      if (tb) timeBase = Number(tb[1]) / Number(tb[2])
      else if (/^0,/.test(line) && !/F=0x/.test(line) && timeBase) times.push(Number(line.split(',')[2]) * timeBase)
    }
  }, signal)
  return times.sort((a, b) => a - b)
}

/**
 * fast: stream copy from the keyframe at or before `start`, instant and lossless, in the
 * source's container. exact: re-encodes from `start` exactly, as compatible H.264 MP4.
 */
export async function trimRecording(input: string, output: string, start: number, end: number, mode: 'fast' | 'exact',
  options: JobOptions & { keyframes?: number[] } = {}): Promise<{ start: number; end: number }> {
  const info = await probeMedia(input)
  if (!(end > start) || start < 0 || end > info.seconds + 0.5) throw new Error('Choose an in point before the out point')
  let from = start
  if (mode === 'fast') {
    const keyframes = options.keyframes ?? await keyframeTimes(input, options.signal)
    from = [...keyframes].reverse().find(time => time <= start + 0.001) ?? 0
  }
  const duration = end - from
  // Either mode is estimated at the master's bitrate over the kept span.
  await ensureFreeSpace(output, (await fs.stat(input)).size * (info.seconds > 0 ? Math.min(1, duration / info.seconds) : 1))
  const mp4 = mode === 'exact' || output.endsWith('.mp4')
  const streams = mode === 'fast'
    ? ['-map', '0', '-c', 'copy', ...(info.video?.codec === 'hevc' && mp4 ? ['-tag:v', 'hvc1'] : []), '-avoid_negative_ts', 'make_zero']
    : ['-map', '0:v:0', ...compatibleVideo(await bestExportEncoder(options.preferredEncoder), 18),
      ...(info.audio.length ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '256k'] : [])]
  await writeNew(output, partial => runFfmpeg(['-n', '-ss', from.toFixed(6), '-i', input, '-t', duration.toFixed(6), ...streams,
    ...(mp4 ? ['-movflags', '+faststart'] : []), ...progressArgs(options), partial], 0,
  options.onProgress && progressReader(duration, options.onProgress), options.signal))
  return { start: from, end }
}

/**
 * The keyframe at or before `seconds` as BGRA pixels, for thumbnails and the scrubber of unplayable
 * masters. Without passthrough, frame-rate sync discards decoded frames before the seek point and
 * -noaccurate_seek still decodes up to it; with it, one keyframe is decoded (45 ms, not 400 ms).
 */
export async function grabFrame(input: string, seconds: number, width: number, height: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  await runFfmpeg(['-noaccurate_seek', '-skip_frame', 'nokey', '-threads', '1', '-ss', Math.max(0, seconds).toFixed(3), '-i', input,
    '-map', '0:v:0', '-frames:v', '1', '-fps_mode', 'passthrough', '-vf', `scale=${width}:${height}:flags=bilinear,format=bgra`,
    '-f', 'rawvideo', 'pipe:1'],
  15000, data => chunks.push(data))
  const frame = Buffer.concat(chunks)
  if (frame.length !== width * height * 4) throw new Error('No frame at this position')
  return frame
}
