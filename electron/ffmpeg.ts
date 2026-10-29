import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Windows runs the trimmed FFmpeg 6.1.1 from vendor/ffmpeg (scripts/ffmpeg/README.md): packaged
// builds carry it in resources/, dev runs and bundles under .test-output/* find it in the repo.
// The Windows package excludes ffmpeg-static, so it may only be loaded on other platforms.
function resolveFfmpeg(): string {
  if (process.platform !== 'win32') {
    const ffmpegPath = require('ffmpeg-static') as string | null
    return ffmpegPath?.replace('app.asar', 'app.asar.unpacked') || ''
  }
  const vendored = path.join('vendor', 'ffmpeg', 'win32-x64', 'ffmpeg.exe')
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'ffmpeg.exe')] : []),
    path.join(__dirname, '..', vendored),
    path.join(__dirname, '..', '..', vendored),
  ]
  return candidates.find(file => existsSync(file)) || candidates[0]
}

export const ffmpegBinary = resolveFfmpeg()

export class CancelledError extends Error {
  constructor() { super('Cancelled') }
}

export function runFfmpeg(args: string[], timeout = 0, onStdout?: (data: Buffer) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancelledError()); return }
    const child = spawn(ffmpegBinary, ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    let log = ''
    const append = (data: Buffer) => { log = (log + data.toString()).slice(-24_000) }
    child.stdout.on('data', onStdout || append)
    child.stderr.on('data', append)
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : undefined
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(new CancelledError()); return }
      // Some Windows FFmpeg builds return zero on output-open failure (-n).
      // Never treat that as a successful remux and delete the input afterwards.
      if (code === 0 && !/Error opening (?:input|output) file|Conversion failed!|No space left on device/i.test(log)) resolve(log)
      else reject(new Error(`FFmpeg exited (${code}): ${log.slice(-4000)}`))
    })
  })
}

/** Calls back with the fraction done from -progress output; the caller passes the duration. */
export function progressReader(seconds: number, onProgress: (fraction: number) => void): (data: Buffer) => void {
  let pending = ''
  return data => {
    const lines = (pending + data.toString()).split('\n')
    pending = lines.pop() || ''
    for (const line of lines) {
      const time = /^out_time_us=(\d+)/.exec(line)
      if (time && seconds > 0) onProgress(Math.min(1, Number(time[1]) / 1e6 / seconds))
    }
  }
}
