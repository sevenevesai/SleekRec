import { AppSettings, CaptureRegion, EncoderFamily, NativeCodec, NativeDisplay, qualityPresets } from '../src/recording'
import { runFfmpeg } from './ffmpeg'

// Capture runs ddagrab inside -filter_complex on a device created for the adapter that owns
// the display (docs/recording.md, "Native video"). Each family encodes on that adapter.

const NVIDIA = 0x10de
const AMD = 0x1002
const INTEL = 0x8086

export function familiesFor(vendorId: number): EncoderFamily[] {
  if (vendorId === NVIDIA) return ['nvenc', 'mf']
  if (vendorId === AMD) return ['amf', 'mf']
  if (vendorId === INTEL) return ['qsv', 'mf']
  return ['mf']
}

export const encoderName = (family: EncoderFamily, codec: NativeCodec): string =>
  `${codec === 'hevc' ? 'hevc' : 'h264'}_${family}`

export interface CaptureVideo {
  display: NativeDisplay
  family: EncoderFamily
  fps: number
  region?: CaptureRegion
}

/** Global options; they must precede every input. */
export function captureDeviceArgs(display: NativeDisplay): string[] {
  return ['-init_hw_device', `d3d11va=sleekgpu:${display.adapter}`, '-filter_hw_device', 'sleekgpu']
}

/** The filtergraph from ddagrab to the encoder input, labelled [v]. */
export function captureGraph({ display, family, fps, region }: CaptureVideo): string {
  const crop = region ? `:offset_x=${region.x - display.x}:offset_y=${region.y - display.y}` +
    `:video_size=${region.width}x${region.height}` : ''
  // QSV maps only fixed frame pools (scripts/ffmpeg/patches/0003); the others keep ddagrab's
  // dynamic pool.
  const pool = family === 'qsv' ? ':extra_hw_frames=24' : ''
  // Drop sub-millisecond catch-up frames before quantizing to Matroska's millisecond time
  // base; these metadata filters leave the surfaces on the GPU.
  const timing = "select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.001)',settb=1/1000"
  const convert = {
    // NVENC and AMF read the BGRA D3D11 texture and convert to YUV on the encoder.
    nvenc: '', amf: '',
    qsv: ',hwmap=derive_device=qsv,format=qsv,vpp_qsv=format=nv12:out_color_matrix=bt709:out_range=tv',
    // Media Foundation takes system-memory NV12: one copy and a CPU conversion per frame.
    mf: ',hwdownload,format=bgra,scale=out_color_matrix=bt709:out_range=tv,format=nv12',
  }[family]
  return `ddagrab=output_idx=${display.output}:framerate=${fps}:draw_mouse=1:output_fmt=bgra${crop}${pool},` +
    `${timing}${convert}[v]`
}

// Media Foundation has no constant-QP mode in FFmpeg 6.1's wrapper; its 0-100 quality scale
// is mapped approximately to the NVENC QP presets.
const mfQuality = { low: 55, medium: 70, high: 82, ultra: 82 } as const

export function captureEncoderArgs(family: EncoderFamily, settings: Pick<AppSettings, 'nativeCodec' | 'qualityPreset'>,
  fps: number, pixelsPerSecond: number, gopSeconds = 2): string[] {
  const hevc = settings.nativeCodec === 'hevc'
  const qp = String(qualityPresets[settings.qualityPreset].qp)
  const gop = String(Math.max(1, Math.round(fps * gopSeconds)))
  const timing = ['-fps_mode', 'passthrough', '-enc_time_base', '1:1000']
  if (family === 'nvenc') {
    const ultra = settings.qualityPreset === 'ultra'
    // P4 measured about 890 Mpix/s on an RTX 2080 Ti, P1 over 1000: above 1440p165 (608 Mpix/s)
    // keeping real time beats file size. At constant QP the preset barely changes visible quality.
    const fastest = ultra || pixelsPerSecond > 2560 * 1440 * 165
    // Leave RGB-to-YUV color signaling to NVENC. Its BGRA conversion uses a
    // BT.601 matrix; overriding the tags to BT.709 changes decoded colors.
    return ['-c:v', encoderName(family, settings.nativeCodec),
      '-preset', fastest ? 'p1' : 'p4', '-tune', ultra ? 'lossless' : 'hq',
      '-rc', 'constqp', '-qp', qp, '-rgb_mode', ultra ? 'yuv444' : 'yuv420', '-multipass', 'disabled',
      // Two frames in flight overlap capture and encoding. Delay zero forces a
      // synchronous bitstream wait for each frame despite allocating 8 surfaces.
      '-b:v', '0', '-rc-lookahead', '0', '-bf', '0', '-surfaces', '8', '-delay', '2', '-g', gop,
      '-profile:v', hevc ? (ultra ? 'rext' : 'main') : (ultra ? 'high444p' : 'high'), ...timing]
  }
  if (family === 'amf') {
    // Above 1080p120 the speed preset keeps real time on integrated GPUs; at constant QP the
    // presets mostly trade file size, not visible quality.
    const quality = pixelsPerSecond > 1920 * 1080 * 120 ? 'speed' : 'balanced'
    return ['-c:v', encoderName(family, settings.nativeCodec), '-usage', 'transcoding', '-quality', quality,
      '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(hevc ? ['-profile:v', 'main'] : ['-qp_b', qp, '-profile:v', 'high']),
      '-bf', '0', '-g', gop, ...timing]
  }
  if (family === 'qsv') {
    // -q:v selects constant QP in qsvenc (global_quality with the qscale flag).
    return ['-c:v', encoderName(family, settings.nativeCodec), '-preset', 'veryfast', '-q:v', qp,
      ...(hevc ? ['-profile:v', 'main'] : ['-look_ahead', '0', '-profile:v', 'high']), '-bf', '0', '-g', gop,
      '-async_depth', '4', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv', ...timing]
  }
  // FFmpeg 6.1's Media Foundation wrapper ignores -g; forced keyframes keep cut points regular.
  return ['-c:v', encoderName(family, settings.nativeCodec), '-hw_encoding', '1', '-rate_control', 'quality',
    '-quality', String(mfQuality[settings.qualityPreset]), ...(hevc ? [] : ['-profile:v', '100']), '-bf', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${gopSeconds})`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv', ...timing]
}

/**
 * FFmpeg 6.1 falls back to the default adapter, without an error, when the index is not
 * enumerable. It logs the adapter it opened only when the index resolved.
 */
export function openedExpectedAdapter(log: string, display: NativeDisplay): boolean {
  const match = /Using device ([0-9a-f]{4}):([0-9a-f]{4})/i.exec(log)
  return !!match && parseInt(match[1], 16) === display.vendorId && parseInt(match[2], 16) === display.deviceId
}

type AdapterProbe = { encoders: Partial<Record<NativeCodec, EncoderFamily>>; error?: string }
const probes = new Map<string, { result: Promise<AdapterProbe>; startedAt: number; failed?: boolean }>()
const RETRY_FAILED_PROBE_MS = 60_000

/**
 * Runs the real capture graph for two frames per codec and family, so a family counts as
 * available only when this adapter, its driver and the encoder options all initialize.
 */
async function probeAdapter(display: NativeDisplay): Promise<AdapterProbe> {
  const failures: string[] = []
  const probeCodec = async (codec: NativeCodec): Promise<EncoderFamily | undefined> => {
    for (const family of familiesFor(display.vendorId)) {
      const settings = { nativeCodec: codec, qualityPreset: 'medium' } as const
      try {
        const log = await runFfmpeg(['-v', 'info', ...captureDeviceArgs(display),
          '-filter_complex', captureGraph({ display, family, fps: 30 }), '-map', '[v]',
          ...captureEncoderArgs(family, settings, 30, display.width * display.height * 30),
          '-frames:v', '2', '-f', 'null', '-'], 15000)
        if (openedExpectedAdapter(log, display)) return family
        failures.push(`${encoderName(family, codec)}: FFmpeg did not open ${display.adapterName}`)
      } catch (error) {
        const lines = String(error).split(/\r?\n/).filter(line => /error|fail|not|unsupported|invalid/i.test(line))
        failures.push(`${encoderName(family, codec)}: ${lines.slice(-2).join(' ').slice(0, 300)}`)
      }
    }
    return undefined
  }
  const [h264, hevc] = await Promise.all([probeCodec('h264'), probeCodec('hevc')])
  const encoders: AdapterProbe['encoders'] = {}
  if (h264) encoders.h264 = h264
  if (hevc) encoders.hevc = hevc
  return { encoders, ...(!h264 && !hevc ? { error: failures.join('\n') } : {}) }
}

/**
 * Adds probed encoders to each display. Results are cached per adapter LUID for the app
 * session. A probe that found nothing is retried after a minute, since a fullscreen game or
 * a driver reset can make Desktop Duplication briefly unavailable.
 */
export async function withEncoders(displays: NativeDisplay[]): Promise<NativeDisplay[]> {
  const byAdapter = new Map<string, NativeDisplay>()
  for (const display of displays) {
    if (display.rotation <= 1 && !byAdapter.has(display.luid)) byAdapter.set(display.luid, display)
  }
  const pending = new Map<string, Promise<AdapterProbe>>()
  for (const [luid, display] of byAdapter) {
    let probe = probes.get(luid)
    if (!probe || (probe.failed && Date.now() - probe.startedAt > RETRY_FAILED_PROBE_MS)) {
      const entry: { result: Promise<AdapterProbe>; startedAt: number; failed?: boolean } =
        { result: probeAdapter(display), startedAt: Date.now() }
      void entry.result.then(result => { entry.failed = !!result.error })
      probes.set(luid, entry)
      probe = entry
    }
    pending.set(luid, probe.result)
  }
  const results = new Map<string, AdapterProbe>()
  for (const [luid, result] of pending) results.set(luid, await result)
  return displays.map(display => {
    const result = results.get(display.luid)
    return result ? { ...display, encoders: result.encoders, ...(result.error ? { probeError: result.error } : {}) } : display
  })
}
