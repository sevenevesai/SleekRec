import fs from 'node:fs/promises'
import path from 'node:path'
import { runFfmpeg } from './ffmpeg'
import { probeMedia } from './media-probe'

export interface FinalizeOptions {
  /** MP4 for editors, players and chat apps; false keeps the Matroska master (Ultra 4:4:4). */
  mp4: boolean
  hevc: boolean
  audioTracks: string[]
  /** Encoded video packets and seconds the capture reported; the MP4 must contain exactly these. */
  expectedFrames: number
  expectedSeconds: number
  /** `AppSettings.mp4MaxGB` in bytes: larger recordings keep the MKV master. 0 or absent: no limit. */
  mp4MaxBytes?: number
  /** Tests only; defaults to `FASTSTART_MAX_BYTES`. */
  faststartMaxBytes?: number
  onProgress?: (fraction: number) => void
}

export interface Finalized {
  path: string
  warning?: string
  /** A chosen outcome such as MKV above the MP4 limit; `warning` is for faults. */
  note?: string
}

const MiB = 1024 * 1024
export const GiB = 1024 * MiB
/**
 * Larger MP4s are written without faststart. Moving the index to the front rewrites the whole
 * file (2.5x the stop time on a hard disk) and only helps playback streamed over HTTP; players and
 * editors open either layout.
 */
export const FASTSTART_MAX_BYTES = 4 * GiB

/** How a stream copy of `bytes` is saved: MKV above the MP4 limit (0 = none), else MP4. */
export function mp4Layout(bytes: number, mp4MaxBytes = 0, faststartMaxBytes = FASTSTART_MAX_BYTES): 'mkv' | 'mp4' | 'faststart' {
  if (mp4MaxBytes > 0 && bytes > mp4MaxBytes) return 'mkv'
  return bytes > faststartMaxBytes ? 'mp4' : 'faststart'
}

const gb = (bytes: number) => `${Number((bytes / GiB).toFixed(1))} GB`

export function overMp4LimitNote(bytes: number, mp4MaxBytes: number): string {
  return `Saved as MKV: ${gb(bytes)} is over the ${gb(mp4MaxBytes)} MP4 limit. Use MP4, same video in Recordings to convert it.`
}

/** MP4 track names and default flags: the mixed track plays in single-track players. */
export function audioTrackArgs(titles: string[]): string[] {
  return titles.flatMap((title, i) => [`-metadata:s:a:${i}`, `title=${title}`, `-metadata:s:a:${i}`,
    `handler_name=${title}`, `-disposition:a:${i}`, i === 0 ? 'default' : '0'])
}

/**
 * Joins capture parts into `${base}.mp4`, or `${base}.mkv` when MP4 is off, over the size limit
 * or fails. The MKV only matters while recording: its clusters survive a crash. After a clean
 * stop the parts are stream-copied once into an MP4 (faststart up to `FASTSTART_MAX_BYTES`),
 * verified by packet count and duration, and deleted only after that. A failed or unverifiable
 * MP4 leaves the Matroska master instead.
 */
export async function finalizeCapture(parts: string[], base: string, options: FinalizeOptions): Promise<Finalized> {
  if (!parts.length) throw new Error('No recording was captured')
  const folder = path.dirname(parts[0])
  const manifest = parts.length > 1 ? path.join(folder, 'parts.ffconcat') : undefined
  if (manifest) {
    await fs.writeFile(manifest, 'ffconcat version 1.0\n' +
      parts.map(file => `file '${path.basename(file)}'`).join('\n') + '\n')
  }
  const input = manifest ? ['-f', 'concat', '-safe', '1', '-i', manifest] : ['-i', parts[0]]
  // fs.rename replaces an existing file on Windows; a finished recording is never replaced.
  const claim = async (file: string) => {
    if (await fs.access(file).then(() => true, () => false)) throw new Error(`${file} already exists`)
  }
  /**
   * Deletes only this session's inputs, and only after the output exists and verified. The
   * recording is saved by then, so a failure (antivirus or a thumbnailer holding a part) becomes
   * a warning; the panel lists the folder as leftover parts of the saved file.
   */
  const removeParts = async (): Promise<string | undefined> => {
    try {
      for (const file of parts) await fs.unlink(file)
      if (manifest) await fs.unlink(manifest)
      await fs.rmdir(folder)
      return undefined
    } catch (error) {
      return `Saved, but the capture parts in ${folder} could not all be deleted (${String(error).split('\n')[0]}). Delete that folder from Recordings.`
    }
  }
  const bytes = (await Promise.all(parts.map(file => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0)
  const disk = await fs.statfs(folder)
  // A stream copy needs room for a second copy of the parts until they are deleted.
  const roomForCopy = disk.bavail * disk.bsize >= bytes + 512 * MiB
  const needed = `${Math.ceil((bytes + 512 * MiB) / 1024 / MiB)} GB`
  const warnings: string[] = []
  const layout = mp4Layout(bytes, options.mp4MaxBytes, options.faststartMaxBytes)
  const note = options.mp4 && layout === 'mkv' ? overMp4LimitNote(bytes, options.mp4MaxBytes!) : undefined
  const result = (file: string): Finalized => ({ path: file, ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    ...(note ? { note } : {}) })
  const makeMp4 = options.mp4 && !note
  let mp4Done = false
  if (makeMp4 && !roomForCopy) {
    warnings.push(`Kept the MKV master: making the MP4 copy needs ${needed} free.`)
  } else if (makeMp4) {
    const partial = `${base}.partial.mp4`
    try {
      let packets = 0
      let crcTimeBase = 0
      let pending = ''
      await runFfmpeg(['-n', ...input, '-map', '0', '-c', 'copy', ...(options.hevc ? ['-tag:v', 'hvc1'] : []),
        ...audioTrackArgs(options.audioTracks), ...(layout === 'faststart' ? ['-movflags', '+faststart'] : []), partial,
        // Count the copied packets from the same read: no second pass over the file.
        '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', 'pipe:1'], 0, data => {
        const lines = (pending + data.toString()).split('\n')
        pending = lines.pop() || ''
        for (const line of lines) {
          const timeBase = /^#tb 0: (\d+)\/(\d+)/.exec(line)
          if (timeBase) crcTimeBase = Number(timeBase[1]) / Number(timeBase[2])
          else if (/^0,/.test(line)) {
            packets++
            if (packets % 120 === 0 && crcTimeBase && options.expectedSeconds) {
              options.onProgress?.(Math.min(1, Number(line.split(',')[2]) * crcTimeBase / options.expectedSeconds))
            }
          }
        }
      })
      const probe = await probeMedia(partial)
      const tolerance = Math.max(1, options.expectedSeconds * 0.01)
      if (packets !== options.expectedFrames) throw new Error(`copied ${packets} of ${options.expectedFrames} video frames`)
      if (!probe.video || probe.audio.length !== options.audioTracks.length) throw new Error('streams are missing')
      if (Math.abs(probe.seconds - options.expectedSeconds) > tolerance) {
        throw new Error(`duration ${probe.seconds.toFixed(1)} s, expected ${options.expectedSeconds.toFixed(1)} s`)
      }
      await claim(`${base}.mp4`)
      await fs.rename(partial, `${base}.mp4`)
      mp4Done = true
    } catch (error) {
      await fs.unlink(partial).catch(() => {}) // Only this function's own unfinished output.
      warnings.push(`Saved as MKV because the MP4 conversion failed: ${String(error).split('\n')[0].slice(0, 300)}`)
    }
    // Cleanup runs outside the conversion's try: a cleanup failure must never fall through to an
    // MKV join from half-deleted parts.
    if (mp4Done) {
      const leftover = await removeParts()
      if (leftover) warnings.push(leftover)
      return result(`${base}.mp4`)
    }
  }
  const output = `${base}.mkv`
  await claim(output)
  if (manifest) {
    if (!roomForCopy) {
      throw new Error(`Joining the ${parts.length} recorded parts needs ${needed} free. They are kept in ${folder}; free some space, then use Recover in Recordings.`)
    }
    const partial = `${base}.partial.mkv`
    try {
      const log = await runFfmpeg(['-n', ...input, '-map', '0', '-c', 'copy', partial])
      // The concat demuxer skips a part it cannot open and still exits 0. The parts are deleted
      // only when every part was read and the join holds the recorded time, allowing for a
      // crash-cut final cluster.
      if (/Impossible to open|Invalid data found when processing input/i.test(log)) {
        throw new Error(`A recorded part could not be read, so the parts are kept in ${folder}; use Recover in Recordings.`)
      }
      const joined = await probeMedia(partial)
      if (joined.seconds < options.expectedSeconds * 0.9 - 1) {
        throw new Error(`The joined recording holds ${joined.seconds.toFixed(1)} s of the ${options.expectedSeconds.toFixed(1)} s captured. The parts are kept in ${folder}; use Recover in Recordings.`)
      }
      await claim(output)
      await fs.rename(partial, output)
    } catch (error) {
      await fs.unlink(partial).catch(() => {}) // Only this function's own unfinished output.
      throw error
    }
    const leftover = await removeParts()
    if (leftover) warnings.push(leftover)
  } else {
    await fs.rename(parts[0], output)
    await fs.rmdir(folder).catch(error => warnings.push(
      `Saved, but the session folder ${folder} could not be removed (${String(error).split('\n')[0]}).`))
  }
  return result(output)
}
