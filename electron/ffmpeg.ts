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

export function runFfmpeg(args: string[], timeout = 0, onStdout?: (data: Buffer) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    let log = ''
    const append = (data: Buffer) => { log = (log + data.toString()).slice(-24_000) }
    child.stdout.on('data', onStdout || append)
    child.stderr.on('data', append)
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : undefined
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      // Some Windows FFmpeg builds return zero on output-open failure (-n).
      // Never treat that as a successful remux and delete the input afterwards.
      if (code === 0 && !/Error opening (?:input|output) file|Conversion failed!|No space left on device/i.test(log)) resolve(log)
      else reject(new Error(`FFmpeg exited (${code}): ${log.slice(-4000)}`))
    })
  })
}
