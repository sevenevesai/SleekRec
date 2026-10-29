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
  const removeParts = async () => {
    // Delete only this session's inputs, and only after the output exists and verified.
    for (const file of parts) await fs.unlink(file)
    if (manifest) await fs.unlink(manifest)
    await fs.rmdir(folder)
  }
  let warning: string | undefined
  if (options.mp4) {
    const bytes = (await Promise.all(parts.map(file => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0)
    const disk = await fs.statfs(folder)
    if (disk.bavail * disk.bsize < bytes + 512 * MiB) {
      warning = `Kept the MKV master: making the MP4 copy needs ${Math.ceil((bytes + 512 * MiB) / 1024 / MiB)} GB free.`
    } else {
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
        await fs.rename(partial, `${base}.mp4`)
        await removeParts()
        return { path: `${base}.mp4` }
      } catch (error) {
        await fs.unlink(partial).catch(() => {}) // Only this function's own unfinished output.
        warning = `Saved as MKV because the MP4 conversion failed: ${String(error).split('\n')[0].slice(0, 300)}`
      }
    }
  }
  const output = `${base}.mkv`
  if (manifest) {
    await runFfmpeg(['-n', ...input, '-map', '0', '-c', 'copy', output])
    await removeParts()
  } else {
    await fs.rename(parts[0], output)
    await fs.rmdir(folder)
  }
  return { path: output, ...(warning ? { warning } : {}) }
}
