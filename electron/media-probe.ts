import { runFfmpeg } from './ffmpeg'

export interface MediaStream {
  index: number
  type: 'video' | 'audio' | 'other'
  codec: string
  width?: number
  height?: number
  fps?: number
  pixelFormat?: string
  title?: string
}

export interface MediaInfo {
  seconds: number
  streams: MediaStream[]
  video?: MediaStream
  audio: MediaStream[]
}

/**
 * Reads the container header with a zero-length stream copy; the trimmed Windows build has no
 * ffprobe. Only the input section is parsed: output streams repeat the same lines.
 */
export function parseProbe(log: string): MediaInfo {
  const input = log.split(/\r?\nOutput #0|\r?\nStream mapping:/)[0]
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(input)
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0
  const streams: MediaStream[] = []
  const lines = input.split(/\r?\n/)
  lines.forEach((line, i) => {
    const match = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Data|Subtitle|Attachment): (\w+)/.exec(line)
    if (!match) return
    const type = match[2] === 'Video' ? 'video' : match[2] === 'Audio' ? 'audio' : 'other'
    const stream: MediaStream = { index: Number(match[1]), type, codec: match[3] }
    if (type === 'video') {
      const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(line)
      if (size) { stream.width = Number(size[1]); stream.height = Number(size[2]) }
      const fps = /([\d.]+) fps/.exec(line)
      if (fps) stream.fps = Number(fps[1])
      stream.pixelFormat = /\b(yuv\w+|yuvj\w+|nv\d+|p0\d0\w*|bgra|bgr0|rgba|rgb\w+|gbrp\w*|gray\w*)\b/.exec(line)?.[1]
    }
    // Stream metadata follows the stream line, indented further.
    for (let j = i + 1; j < lines.length && !/^\s*Stream #/.test(lines[j]); j++) {
      const title = /^\s+(?:title|handler_name)\s*: (.+)$/.exec(lines[j])
      if (title && !stream.title) stream.title = title[1].trim()
    }
    streams.push(stream)
  })
  return { seconds, streams, video: streams.find(s => s.type === 'video'), audio: streams.filter(s => s.type === 'audio') }
}

export async function probeMedia(file: string, timeout = 10000): Promise<MediaInfo> {
  const log = await runFfmpeg(['-i', file, '-map', '0', '-c', 'copy', '-t', '0', '-f', 'null', '-'], timeout)
  return parseProbe(log)
}
