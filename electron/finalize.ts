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
  onProgress?: (fraction: number) => void
}

export interface Finalized {
  path: string
  warning?: string
}

const MiB = 1024 * 1024

/** MP4 track names and default flags: the mixed track plays in single-track players. */
export function audioTrackArgs(titles: string[]): string[] {
  return titles.flatMap((title, i) => [`-metadata:s:a:${i}`, `title=${title}`, `-metadata:s:a:${i}`,
    `handler_name=${title}`, `-disposition:a:${i}`, i === 0 ? 'default' : '0'])
}

/**
 * Joins capture parts into `${base}.mp4`, or `${base}.mkv` when MP4 is off or fails. The MKV
 * only matters while recording: its clusters survive a crash. After a clean stop the parts are
 * stream-copied once into a faststart MP4, verified by packet count and duration, and deleted
 * only after that. A failed or unverifiable MP4 leaves the Matroska master instead.
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
  const result = (file: string): Finalized => ({ path: file, ...(warnings.length ? { warning: warnings.join(' ') } : {}) })
  let mp4Done = false
  if (options.mp4 && !roomForCopy) {
    warnings.push(`Kept the MKV master: making the MP4 copy needs ${needed} free.`)
  } else if (options.mp4) {
    const partial = `${base}.partial.mp4`
    try {
      let packets = 0
      let crcTimeBase = 0
      let pending = ''
      await runFfmpeg(['-n', ...input, '-map', '0', '-c', 'copy', ...(options.hevc ? ['-tag:v', 'hvc1'] : []),
        ...audioTrackArgs(options.audioTracks), '-movflags', '+faststart', partial,
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
