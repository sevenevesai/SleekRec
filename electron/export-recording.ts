import { runFfmpeg } from './ffmpeg'

let nvencAvailable: Promise<boolean> | undefined
function canEncodeOnGPU(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  if (!nvencAvailable) {
    nvencAvailable = runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=size=256x144',
      '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 10000).then(() => true, () => false)
  }
  return nvencAvailable
}

export async function exportRecording(input: string, output: string, mode: 'copy' | 'small'): Promise<void> {
  const log = await runFfmpeg(['-i', input, '-map', '0:v:0', '-c', 'copy', '-t', '0', '-f', 'null', '-'], 10000)
  const codec = log.match(/Video:\s*(\w+)/)?.[1]
  const audio = log.match(/Audio:\s*(\w+)/)?.[1]
  if (mode === 'copy' && codec !== 'h264' && codec !== 'hevc') {
    throw new Error('This master needs H.264 conversion for MP4. Choose Smaller MP4; the original will be kept.')
  }
  const video = mode === 'copy' ? ['-c:v', 'copy', ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : await canEncodeOnGPU()
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', '24', '-b:v', '0', '-bf', '0',
        '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-enc_time_base', '1:1000000']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr']
  await runFfmpeg(['-n', '-i', input, '-map', '0:v:0', '-map', '0:a?', ...video,
    ...(audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart', output])
}
