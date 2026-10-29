// Timestamped PCM avoids assigning read-time timestamps to buffered audio.
// Matroska carries each packet's capture time; FFmpeg compensates clock drift.
// Force the resampler on at startup. FFmpeg 6.1 otherwise initializes it at the
// first soft clock correction and can pad the entire elapsed time with silence.
export const pcmAudioFilter = 'aresample=async=1000:first_pts=0:flags=res,asetpts=N/SR/TB'

function id(value: number): Buffer {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')
}
function size(value: number): Buffer {
  let bytes = 1
  while (value >= 2 ** (7 * bytes) - 1) bytes++
  const output = Buffer.alloc(bytes)
  let remainder = value
  for (let i = bytes - 1; i >= 0; i--) { output[i] = remainder % 256; remainder = Math.floor(remainder / 256) }
  output[0] |= 1 << (8 - bytes)
  return output
}
function element(tag: number, data: Buffer): Buffer {
  return Buffer.concat([id(tag), size(data.length), data])
}
function uint(tag: number, value: number): Buffer {
  let bytes = 1
  while (value >= 2 ** (8 * bytes)) bytes++
  const data = Buffer.alloc(bytes)
  data.writeUIntBE(value, 0, bytes)
  return element(tag, data)
}

export function pcmHeader(sampleRate: number, channels: number, tracks = 1): Buffer {
  const rate = Buffer.alloc(8)
  rate.writeDoubleBE(sampleRate)
  return Buffer.concat([
    element(0x1a45dfa3, Buffer.concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4),
      uint(0x42f3, 8), element(0x4282, Buffer.from('matroska')), uint(0x4287, 4), uint(0x4285, 2)])),
    id(0x18538067), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    element(0x1549a966, Buffer.concat([uint(0x2ad7b1, 1_000_000),
      element(0x4d80, Buffer.from('SleekRec')), element(0x5741, Buffer.from('SleekRec'))])),
    element(0x1654ae6b, Buffer.concat(Array.from({ length: tracks }, (_, i) => element(0xae, Buffer.concat([
      uint(0xd7, i + 1), uint(0x73c5, i + 1), uint(0x83, 2),
      element(0x86, Buffer.from('A_PCM/FLOAT/IEEE')), element(0xe1, Buffer.concat([
        element(0xb5, rate), uint(0x9f, channels), uint(0x6264, 32)]))]))))),
  ])
}

/**
 * One cluster per capture chunk with a SimpleBlock per track, so every track carries the same
 * capture timestamp and FFmpeg's per-track resampling makes identical drift corrections.
 */
export function pcmPacket(milliseconds: number, tracks: Buffer | Buffer[]): Buffer {
  const blocks = (Array.isArray(tracks) ? tracks : [tracks]).map((data, i) =>
    element(0xa3, Buffer.concat([Buffer.from([0x81 + i, 0, 0, 0x80]), data])))
  return element(0x1f43b675, Buffer.concat([uint(0xe7, Math.max(0, Math.round(milliseconds))), ...blocks]))
}
