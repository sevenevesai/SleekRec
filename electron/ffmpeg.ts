import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

export const ffmpegBinary = ffmpegPath?.replace('app.asar', 'app.asar.unpacked') || ''

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
