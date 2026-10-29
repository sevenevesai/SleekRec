const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.test-output', 'unit')
// Each module is bundled on its own; tests use only what the bundles export.
const load = (entry, name) => {
  buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs',
    external: ['ffmpeg-static'], outfile: path.join(output, `${name}.cjs`) })
  return require(path.join(output, `${name}.cjs`))
}
const { BrowserRecorder } = load('electron/browser-recorder.ts', 'browser')
const { runFfmpeg, ffmpegBinary } = load('electron/ffmpeg.ts', 'ffmpeg')
const { exportRecording, fitPlan, fitToSize, keyframeTimes, trimRecording, grabFrame } = load('electron/export-recording.ts', 'export')
const { pcmHeader, pcmPacket, pcmAudioFilter } = load('electron/pcm-matroska.ts', 'pcm')
const { FramePacingMeter } = load('electron/frame-pacing.ts', 'pacing')
const { listNativeDisplays } = load('electron/native-recorder.ts', 'native')
const { captureDeviceArgs, captureEncoderArgs, captureGraph, encoderName, openedExpectedAdapter, withEncoders } =
  load('electron/gpu-capture.ts', 'gpu')
const { finalizeCapture, audioTrackArgs } = load('electron/finalize.ts', 'finalize')
const { ReplayBuffer, REPLAY_DIRECTORY } = load('electron/replay-buffer.ts', 'replay')
const { listLibrary, libraryPath, recoverUnfinished, uniqueOutput } = load('electron/library.ts', 'library')
const { probeMedia, parseProbe } = load('electron/media-probe.ts', 'probe')
const { normalizeSettings, isValidHotkey } = load('electron/settings.ts', 'stored-settings')
const { captureEngineForSource, requestedFps, gpuSupport, clampRegion, audioTrackTitles, defaultHotkeys } =
  load('src/recording.ts', 'settings')
const helper = path.join(root, 'native', 'bin', 'windows-displays.exe')
const settings = { outputFolder: output, qualityPreset: 'ultra' }
const info = { engine: 'browser', codec: 'h264', width: 160, height: 96, targetFps: 120 }
const hash = file => runFfmpeg(['-v', 'error', '-i', file, '-map', '0:v', '-f', 'hash', '-hash', 'sha256', '-'])

test('ordered acknowledged chunks retain every 120 fps frame through MP4 remux and repeated stop', async () => {
  const fixture = path.join(output, 'source.mkv')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=120',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.25',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', fixture])
  const buffer = await fs.readFile(fixture)
  const recorder = new BrowserRecorder(settings, { ...info, width: 2560, height: 1440 }, 'h264')
  await recorder.start()
  const writes = []
  // Deliberately queue independent IPC-sized writes before awaiting them.
  for (let i = 0; i < buffer.length; i += 733) {
    const part = buffer.subarray(i, i + 733)
    writes.push(recorder.write(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)))
  }
  await Promise.all(writes)
  await recorder.flush()
  const first = recorder.stop()
  const second = recorder.stop()
  assert.equal(first, second)
  const saved = await first
  assert.equal(await hash(saved.path), await hash(fixture), 'decoded frames must be identical')
  const log = await runFfmpeg(['-i', saved.path, '-map', '0:v', '-c', 'copy', '-t', '0', '-f', 'null', '-'])
  assert.match(log, /120 fps/)
  assert.match(log, /Audio: aac/)
  assert.equal(saved.info.width, 160, 'Saved dimensions must replace the initial track estimate')
  assert.equal(saved.info.height, 96)
  assert.equal(saved.stats.pacing.frames, 150)
  assert.ok(Math.abs(saved.stats.pacing.averageFps - 120) < 0.1)
  assert.ok(saved.stats.pacing.p95GapMs <= 9)
  assert.equal(saved.stats.pacing.gapsOver100ms, 0)
  await assert.rejects(recorder.write(new ArrayBuffer(1)), /closed/)
})

test('VP9 fallback retains original compressed bytes without mandatory H.264 conversion', async () => {
  const fixture = path.join(output, 'source.webm')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=60', '-t', '0.5',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', fixture])
  const bytes = await fs.readFile(fixture)
  const recorder = new BrowserRecorder(settings, { ...info, codec: 'vp9' }, 'vp9')
  await recorder.start()
  await recorder.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const saved = await recorder.stop()
  assert.match(saved.path, /\.webm$/)
  assert.deepEqual(await fs.readFile(saved.path), bytes)
})

test('failed conversion keeps the partial recording available for recovery', async () => {
  const recorder = new BrowserRecorder(settings, info, 'h264')
  await recorder.start()
  await recorder.write(Uint8Array.of(1, 2, 3, 4).buffer)
  await assert.rejects(recorder.stop(), /FFmpeg/)
  const files = await fs.readdir(output)
  assert.ok(files.some(file => file.includes(recorder.id.slice(0, 8)) && file.endsWith('.partial.mkv')))
  await recorder.abort()
})

test('unwritable output and oversized chunks fail explicitly', async () => {
  const file = path.join(output, 'not-a-directory')
  await fs.writeFile(file, '')
  const invalid = new BrowserRecorder({ ...settings, outputFolder: file }, info, 'h264')
  await assert.rejects(invalid.start())
  await invalid.abort()
  const recorder = new BrowserRecorder(settings, info, 'vp9')
  await recorder.start()
  await assert.rejects(recorder.write(new ArrayBuffer(64 * 1024 * 1024 + 1)), /64 MB/)
  await recorder.abort()
})

test('MP4 exports preserve masters, copy video losslessly, and retain high frame rates when compressing', async () => {
  const fixture = path.join(output, 'export-source.mkv')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=120',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-c:a', 'aac', fixture])
  const original = await fs.readFile(fixture)
  const copy = path.join(output, `copy-${Date.now()}.mp4`)
  const small = path.join(output, `small-${Date.now()}.mp4`)
  await exportRecording(fixture, copy, 'copy')
  assert.equal(await hash(copy), await hash(fixture))
  await assert.rejects(exportRecording(fixture, copy, 'copy'), /already exists/)
  await exportRecording(fixture, small, 'small')
  const packets = await runFfmpeg(['-v', 'error', '-i', small, '-map', '0:v', '-c', 'copy', '-f', 'framecrc', '-'])
  assert.equal(packets.split('\n').filter(line => /^0,/.test(line)).length, 120)
  assert.deepEqual(await fs.readFile(fixture), original)
})

test('timestamped PCM survives buffered delivery without duplicate AAC timestamps', async () => {
  const input = path.join(output, 'clocked-pcm.mkv')
  const audio = path.join(output, 'clocked-aac.mkv')
  const packets = [pcmHeader(48000, 2)]
  for (let i = 0; i < 100; i++) packets.push(pcmPacket(i * 2048 / 48, Buffer.alloc(2048 * 2 * 4)))
  await fs.writeFile(input, Buffer.concat(packets))
  await runFfmpeg(['-y', '-i', input, '-af', pcmAudioFilter, '-c:a', 'aac', audio])
  const log = await runFfmpeg(['-v', 'error', '-i', audio, '-c', 'copy', '-f', 'framecrc', '-'])
  const timestamps = log.split('\n').filter(line => /^0,/.test(line)).map(line => Number(line.split(',')[1]))
  assert.ok(timestamps.length >= 200)
  timestamps.forEach((value, i) => assert.ok(i === 0 || value > timestamps[i - 1]))
})

test('the first clock-drift correction does not insert a long silence or stall live audio', async () => {
  const input = path.join(output, 'drifting-tone.mkv')
  const raw = path.join(output, 'corrected-tone.f32')
  const packets = [pcmHeader(48000, 2)]
  for (let packet = 0; packet < 200; packet++) {
    const samples = new Float32Array(2048 * 2)
    for (let i = 0; i < 2048; i++) samples[i * 2] = samples[i * 2 + 1] = 0.25 * Math.sin((packet * 2048 + i) * 2 * Math.PI * 440 / 48000)
    packets.push(pcmPacket(packet * 2048 / 48 * 1.002, Buffer.from(samples.buffer)))
  }
  await fs.writeFile(input, Buffer.concat(packets))
  await runFfmpeg(['-y', '-i', input, '-af', pcmAudioFilter, '-c:a', 'pcm_f32le', '-f', 'f32le', raw])
  const samples = await fs.readFile(raw)
  const frames = samples.length / 8
  assert.ok(Math.abs(frames / 48000 - 200 * 2048 / 48000 * 1.002) < 0.03)
  for (let start = 4800; start < frames - 4800; start += 480) {
    let energy = 0
    for (let i = start; i < start + 480; i++) energy += samples.readFloatLE(i * 8) ** 2
    assert.ok(Math.sqrt(energy / 480) > 0.05, 'Unexpected silence during clock compensation')
  }
})

test('frame pacing measures long gaps, accepts fragmented telemetry, and excludes paused time', () => {
  const meter = new FramePacingMeter()
  meter.write(Buffer.from('sleek_pts=100 1/1000\nsleek_p'))
  meter.write(Buffer.from('ts=106 1/1000\nsleek_pts=112 1/1000\nprogress=continue\n'))
  meter.add(218)
  meter.add(224)
  meter.beginSegment()
  for (const t of [0, 6, 12]) meter.add(t)
  const stats = meter.snapshot()
  assert.equal(stats.frames, 8)
  assert.equal(stats.maxGapMs, 106)
  assert.equal(stats.gapsOver50ms, 1)
  assert.equal(stats.gapsOver100ms, 1)
  assert.equal(stats.nonMonotonicTimestamps, 0)
  assert.ok(Math.abs(stats.averageFps - 6000 / 136) < 0.001)
  meter.add(12)
  assert.equal(meter.snapshot().nonMonotonicTimestamps, 1)
})

test('an unmatched Windows screen cannot silently switch Automatic recording to the browser', () => {
  const screen = { id: 'screen:0:0', name: 'Screen 1', thumbnail: '', refreshRate: 165,
    gpuUnavailableReason: 'GPU display mapping is unavailable' }
  assert.throws(() => captureEngineForSource(screen, 'auto'), /mapping is unavailable/)
  assert.equal(captureEngineForSource(screen, 'browser'), 'browser')
  const supported = { ...screen, gpuUnavailableReason: undefined, nativeDisplay: { output: 0 } }
  assert.equal(captureEngineForSource(supported, 'auto'), 'native')
  const window = { id: 'window:123:0', name: 'Game', thumbnail: '', refreshRate: 165, recommendedScreenId: 'screen:0:0' }
  assert.equal(captureEngineForSource(window, 'auto'), 'browser', 'A recommendation must not widen window capture')
  assert.equal(requestedFps('display', window.refreshRate), 165)
})

test('Ultra encodes all 4:4:4 samples losslessly for H.264 and HEVC when NVENC is available', async t => {
  try {
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=size=256x144',
      '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 10000)
  } catch { t.skip('NVENC is unavailable on this machine'); return }
  const input = path.join(output, 'color444.mkv')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=256x144:rate=165,format=yuv444p',
    '-t', '1', '-c:v', 'ffv1', input])
  const expected = await hash(input)
  for (const codec of ['h264', 'hevc']) {
    const encoded = path.join(output, `ultra-${codec}.mkv`)
    await runFfmpeg(['-y', '-i', input, ...captureEncoderArgs('nvenc', { ...settings, nativeCodec: codec }, 165, 256 * 144 * 165), encoded])
    assert.equal(await hash(encoded), expected, `${codec}: lossless encoding must preserve every YUV sample`)
    const probe = await runFfmpeg(['-i', encoded, '-map', '0:v', '-c', 'copy', '-t', '0', '-f', 'null', '-'])
    assert.match(probe, /yuv444p/)
    const copy = path.join(output, `ultra-${codec}-copy-${Date.now()}.mp4`)
    const small = path.join(output, `ultra-${codec}-small-${Date.now()}.mp4`)
    await exportRecording(encoded, copy, 'copy')
    assert.equal(await hash(copy), expected, 'MP4 remux must preserve the 4:4:4 master')
    await exportRecording(encoded, small, 'small')
    const report = await runFfmpeg(['-v', 'error', '-i', small, '-map', '0:v', '-c', 'copy', '-f', 'framecrc', '-'])
    const smallProbe = await runFfmpeg(['-i', small, '-map', '0:v', '-c', 'copy', '-t', '0', '-f', 'null', '-'])
    assert.match(smallProbe, /yuv420p/)
    assert.equal(report.split('\n').filter(line => /^0,/.test(line)).length, 165)
    assert.equal(await hash(encoded), expected, 'Compression must keep the master intact')
  }
})

// ---- Settings, hotkeys and GPU selection ----

const defaults = { outputFolder: output, qualityPreset: 'medium', recordingEngine: 'auto', frameRate: 'display',
  nativeCodec: 'h264', systemAudio: true, columnCount: 2, micEnabled: false, micDeviceId: null, micVolume: 0.8,
  micRawInput: false, micTrack: 'mixed', hotkeys: { ...defaultHotkeys }, replaySeconds: 120, replayAutoArm: false,
  startMinimized: false, closeToTray: false, launchAtLogin: false, lastSource: null }

test('stored settings from older versions gain defaults, and invalid hotkeys and sources are refused', () => {
  const old = normalizeSettings({ outputFolder: output, qualityPreset: 'high', columnCount: 3 }, defaults)
  assert.equal(old.qualityPreset, 'high')
  assert.equal(old.micTrack, 'mixed')
  assert.deepEqual(old.hotkeys, defaultHotkeys)
  assert.equal(old.lastSource, null)
  const edited = normalizeSettings({ hotkeys: { record: 'CommandOrControl+Shift+F8', stop: 'CommandOrControl+Shift+F8',
    pause: 'A', replaySave: '', replayToggle: 'Alt+Shift+R' }, replaySeconds: 45,
    lastSource: { id: 'screen:1:0', name: 'Screen', region: { x: 10, y: 20, width: 640, height: 360 } } }, defaults)
  assert.equal(edited.hotkeys.record, 'CommandOrControl+Shift+F8')
  assert.equal(edited.hotkeys.stop, '', 'One accelerator triggers one action')
  assert.equal(edited.hotkeys.pause, defaultHotkeys.pause, 'A bare letter would swallow typing in every app')
  assert.equal(edited.hotkeys.replaySave, '', 'An empty hotkey stays off')
  assert.equal(edited.hotkeys.replayToggle, 'Alt+Shift+R')
  assert.equal(edited.replaySeconds, 120)
  assert.deepEqual(edited.lastSource.region, { x: 10, y: 20, width: 640, height: 360 })
  assert.equal(normalizeSettings({ lastSource: { id: 'file:C:/x', name: 'x' } }, defaults).lastSource, null)
  for (const ok of ['F9', 'CommandOrControl+Shift+F8', 'Alt+F12', 'Shift+num5', 'CommandOrControl+Space', 'MediaPlayPause']) assert.ok(isValidHotkey(ok), ok)
  for (const bad of ['A', 'Shift', 'Ctrl+Ctrl+A', 'Hyper+A', 'CommandOrControl+', '']) assert.ok(!isValidHotkey(bad), bad)
})

const display = { adapter: 0, output: 0, x: -2560, y: 0, width: 2560, height: 1440, refreshRate: 165, rotation: 1, hdr: false,
  vendorId: 0x1002, deviceId: 0x164e, adapterName: 'AMD Radeon', luid: '0:1', encoders: { h264: 'amf' } }

test('GPU support names the encoder, refuses lossy Ultra on non-NVIDIA adapters, and crops to even sizes inside the display', () => {
  assert.deepEqual(gpuSupport(display, { nativeCodec: 'h264', qualityPreset: 'high' }), { ok: true, family: 'amf' })
  assert.match(gpuSupport(display, { nativeCodec: 'hevc', qualityPreset: 'high' }).reason, /accepted HEVC.*Choose H\.264/)
  assert.match(gpuSupport(display, { nativeCodec: 'h264', qualityPreset: 'ultra' }).reason, /needs NVIDIA NVENC/)
  assert.match(gpuSupport({ ...display, rotation: 2 }, { nativeCodec: 'h264', qualityPreset: 'high' }).reason, /landscape/)
  assert.throws(() => captureEngineForSource({ id: 'screen:1:0', name: 'S', thumbnail: '', nativeDisplay: display }, 'auto',
    { nativeCodec: 'h264', qualityPreset: 'ultra' }), /NVENC/)
  assert.deepEqual(clampRegion({ x: -2561, y: -5, width: 641.4, height: 361 }, display), { x: -2560, y: 0, width: 640, height: 356 })
  assert.deepEqual(clampRegion({ x: -2559, y: 1, width: 641, height: 362 }, display), { x: -2558, y: 2, width: 640, height: 360 },
    'odd offsets move inward to even ones, keeping the far edges, and sizes round down to even')
  assert.equal(clampRegion({ x: 0, y: 0, width: 500, height: 500 }, display), null, 'outside the display')
  assert.equal(clampRegion({ x: -100, y: 0, width: 63, height: 400 }, display), null, 'narrower than 64 px')
  assert.deepEqual(audioTrackTitles({ systemAudio: true, micEnabled: true, micTrack: 'separate' }), ['Game + microphone', 'Game', 'Microphone'])
  assert.deepEqual(audioTrackTitles({ systemAudio: true, micEnabled: true, micTrack: 'mixed' }), ['Game + microphone'])
  assert.deepEqual(audioTrackTitles({ systemAudio: false, micEnabled: true, micTrack: 'separate' }), ['Microphone'])
})

test('capture graphs crop on the GPU relative to the display, convert per vendor, and detect a silently substituted adapter', () => {
  const region = { x: -2460, y: 50, width: 640, height: 360 }
  const amf = captureGraph({ display, family: 'amf', fps: 165, region })
  assert.match(amf, /^ddagrab=output_idx=0:framerate=165:draw_mouse=1:output_fmt=bgra:offset_x=100:offset_y=50:video_size=640x360,/)
  assert.doesNotMatch(amf, /hwdownload|hwmap/, 'AMF reads the D3D11 texture directly')
  assert.match(captureGraph({ display, family: 'qsv', fps: 60 }), /extra_hw_frames=24.*hwmap=derive_device=qsv,format=qsv,vpp_qsv=format=nv12/)
  assert.match(captureGraph({ display, family: 'mf', fps: 60 }), /hwdownload,format=bgra,scale=.*format=nv12\[v\]$/)
  assert.deepEqual(captureDeviceArgs({ ...display, adapter: 2 }), ['-init_hw_device', 'd3d11va=sleekgpu:2', '-filter_hw_device', 'sleekgpu'])
  assert.ok(openedExpectedAdapter('[AVHWDeviceContext @ 0] Using device 1002:164e (AMD Radeon).', display))
  assert.ok(!openedExpectedAdapter('[AVHWDeviceContext @ 0] Using device 10de:1e07 (NVIDIA).', display))
  assert.ok(!openedExpectedAdapter('no device line: FFmpeg fell back to the default adapter', display))
})

// AMD and Intel encoders cannot initialize on a machine without their GPUs, so verify that the
// bundled FFmpeg recognizes every option SleekRec passes them. A renamed or missing option would
// otherwise only surface on a user's AMD or Intel machine.
test('every vendor encoder and filter option SleekRec passes exists in the bundled FFmpeg', async () => {
  const generic = new Set(['-c:v', '-g', '-bf', '-profile:v', '-q:v', '-b:v', '-colorspace', '-color_primaries', '-color_range',
    '-fps_mode', '-enc_time_base', '-force_key_frames', '-pix_fmt'])
  const known = async (kind, name) => {
    const help = await runFfmpeg(['-h', `${kind}=${name}`])
    assert.doesNotMatch(help, /Unknown (encoder|filter)/, `${name} must be built in`)
    return new Set([...help.matchAll(/^\s+-?([a-z0-9_-]+)\s+<\w+>/gm)].map(match => match[1]))
  }
  for (const family of ['nvenc', 'amf', 'qsv', 'mf']) {
    for (const codec of ['h264', 'hevc']) {
      for (const preset of ['medium', 'ultra']) {
        if (preset === 'ultra' && family !== 'nvenc') continue
        const args = captureEncoderArgs(family, { nativeCodec: codec, qualityPreset: preset }, 165, 2560 * 1440 * 165)
        const options = await known('encoder', encoderName(family, codec))
        assert.equal(args[1], encoderName(family, codec))
        for (const arg of args.filter((value, i) => value.startsWith('-') && i % 2 === 0)) {
          if (!generic.has(arg)) assert.ok(options.has(arg.slice(1)), `${encoderName(family, codec)} has no option ${arg}`)
        }
      }
    }
  }
  const vpp = await known('filter', 'vpp_qsv')
  for (const option of ['format', 'out_color_matrix', 'out_range']) assert.ok(vpp.has(option), `vpp_qsv has no option ${option}`)
  for (const filter of ['hwmap', 'hwdownload', 'hwupload', 'ddagrab']) await known('filter', filter)
})

// ---- Separate audio tracks ----

test('three PCM tracks in one live Matroska stream become three titled AAC tracks with identical, increasing timestamps', async () => {
  const input = path.join(output, 'three-tracks.mkv')
  const encoded = path.join(output, 'three-tracks-aac.mkv')
  const packets = [pcmHeader(48000, 2, 3)]
  for (let i = 0; i < 60; i++) {
    const tracks = [0.3, 0.2, 0.1].map(amplitude => {
      const samples = new Float32Array(2048 * 2)
      for (let s = 0; s < 2048; s++) samples[s * 2] = samples[s * 2 + 1] = amplitude * Math.sin((i * 2048 + s) * 2 * Math.PI * 440 / 48000)
      return Buffer.from(samples.buffer)
    })
    packets.push(pcmPacket(i * 2048 / 48, tracks))
  }
  await fs.writeFile(input, Buffer.concat(packets))
  const titles = ['Game + microphone', 'Game', 'Microphone']
  await runFfmpeg(['-y', '-i', input, '-map', '0:a:0', '-map', '0:a:1', '-map', '0:a:2', '-c:a', 'aac', '-af', pcmAudioFilter,
    ...audioTrackArgs(titles), encoded])
  const probe = await probeMedia(encoded)
  assert.deepEqual(probe.audio.map(stream => stream.codec), ['aac', 'aac', 'aac'])
  assert.deepEqual(probe.audio.map(stream => stream.title), titles)
  const log = await runFfmpeg(['-v', 'error', '-i', encoded, '-map', '0', '-c', 'copy', '-f', 'framecrc', '-'])
  const perTrack = [0, 1, 2].map(track => log.split('\n').filter(line => line.startsWith(`${track},`)).map(line => Number(line.split(',')[1])))
  assert.ok(perTrack[0].length > 100)
  perTrack[0].forEach((value, i) => assert.ok(i === 0 || value > perTrack[0][i - 1]))
  assert.deepEqual(perTrack[1], perTrack[0], 'Every track carries the same capture timeline')
  assert.deepEqual(perTrack[2], perTrack[0])
  const defaults = await runFfmpeg(['-i', encoded, '-t', '0', '-f', 'null', '-']).catch(error => String(error))
  assert.match(defaults.split('Output #0')[0], /Stream #0:0[^\n]*\(default\)/)
  assert.doesNotMatch(defaults.split('Output #0')[0], /Stream #0:1[^\n]*\(default\)/, 'Only the mix plays by default')
})

// ---- Finalize: MP4 on a clean stop ----

async function captureParts(name, count, seconds = 1) {
  const folder = path.join(output, name)
  for (const leftover of [folder, `${folder}.mp4`, `${folder}.mkv`]) await fs.rm(leftover, { recursive: true, force: true })
  await fs.mkdir(folder, { recursive: true })
  const parts = []
  for (let i = 1; i <= count; i++) {
    const part = path.join(folder, `part-00${i}.mkv`)
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=60`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '0', '-c:a', 'aac', part])
    parts.push(part)
  }
  return { folder, parts }
}

test('a clean stop joins parts into a verified faststart MP4 and deletes the parts only afterwards', async () => {
  const { folder, parts } = await captureParts('finalize-mp4', 2)
  const progress = []
  const result = await finalizeCapture(parts, folder, { mp4: true, hevc: false, audioTracks: ['Game'], expectedFrames: 120,
    expectedSeconds: 2, onProgress: fraction => progress.push(fraction) })
  assert.equal(result.path, `${folder}.mp4`)
  assert.equal(result.warning, undefined)
  const probe = await probeMedia(result.path)
  assert.ok(Math.abs(probe.seconds - 2) < 0.1)
  assert.equal(probe.audio[0].title, 'Game')
  const head = (await fs.readFile(result.path)).subarray(0, 64).toString('latin1')
  assert.ok(head.indexOf('moov') > 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'faststart puts moov first')
  await assert.rejects(fs.stat(folder), /ENOENT/, 'parts and the session folder are gone after the MP4 verified')
})

test('an MP4 that does not verify leaves the joined MKV master and says why', async () => {
  const { folder, parts } = await captureParts('finalize-fallback', 2)
  const result = await finalizeCapture(parts, folder, { mp4: true, hevc: false, audioTracks: ['Game'], expectedFrames: 999, expectedSeconds: 2 })
  assert.equal(result.path, `${folder}.mkv`)
  assert.match(result.warning, /Saved as MKV.*copied 120 of 999/)
  await assert.rejects(fs.stat(`${folder}.mp4`), /ENOENT/)
  await assert.rejects(fs.stat(`${folder}.partial.mp4`), /ENOENT/)
  assert.equal((await probeMedia(result.path)).streams.length, 2)
  const ultra = await captureParts('finalize-ultra', 1)
  const kept = await finalizeCapture(ultra.parts, ultra.folder, { mp4: false, hevc: false, audioTracks: ['Game'], expectedFrames: 60, expectedSeconds: 1 })
  assert.equal(kept.path, `${ultra.folder}.mkv`, 'Ultra keeps its Matroska master')
  const clash = await captureParts('finalize-clash', 1)
  await fs.writeFile(`${clash.folder}.mkv`, 'an earlier recording')
  await assert.rejects(finalizeCapture(clash.parts, clash.folder, { mp4: false, hevc: false, audioTracks: ['Game'],
    expectedFrames: 60, expectedSeconds: 1 }), /already exists/)
  assert.equal(await fs.readFile(`${clash.folder}.mkv`, 'utf8'), 'an earlier recording', 'an existing file is never replaced')
  assert.ok((await fs.stat(clash.parts[0])).size > 0, 'and the parts stay')
  const broken = await captureParts('finalize-broken', 2)
  await fs.writeFile(broken.parts[1], 'not a Matroska file')
  await assert.rejects(finalizeCapture(broken.parts, broken.folder, { mp4: false, hevc: false, audioTracks: ['Game'],
    expectedFrames: 120, expectedSeconds: 2 }))
  await assert.rejects(fs.stat(`${broken.folder}.mkv`), /ENOENT/, 'a failed join leaves no truncated recording')
  await assert.rejects(fs.stat(`${broken.folder}.partial.mkv`), /ENOENT/)
  assert.ok((await fs.stat(broken.parts[0])).size > 0, 'and keeps the parts for recovery')
})

// ---- Library, recovery, trim and fit-to-size ----

test('the library lists recordings by kind, refuses paths outside the output folder, and recovers unfinished parts without deleting them', async () => {
  const folder = path.join(output, 'library')
  await fs.rm(folder, { recursive: true, force: true })
  await fs.mkdir(path.join(folder, REPLAY_DIRECTORY, 'abcd'), { recursive: true })
  const { parts } = await captureParts(path.join('library', 'Recording_2026-10-29T10-00-00-000Z_aaaa1111'), 2)
  const clip = path.join(folder, 'Recording_2026-10-29T11-00-00-000Z_bbbb2222.mp4')
  await fs.copyFile(parts[0], clip.replace('.mp4', '.mkv'))
  await runFfmpeg(['-y', '-i', parts[0], '-c', 'copy', clip])
  await fs.writeFile(`${clip}.json`, JSON.stringify({ path: clip, info: { engine: 'native', kind: 'replay', width: 320, height: 180,
    codec: 'H.264 / NVIDIA NVENC', audioTracks: ['Game'] }, stats: { seconds: 1, pacing: { averageFps: 59.9, gapsOver100ms: 0 } } }))
  await fs.writeFile(path.join(folder, 'Recording_2026-10-29T12-00-00-000Z_cccc3333.partial.mkv'), 'x')
  await fs.writeFile(path.join(folder, 'notes.txt'), 'not a recording')
  const entries = await listLibrary(folder)
  const kinds = Object.fromEntries(entries.map(entry => [entry.name, entry.kind]))
  assert.equal(kinds[path.basename(clip)], 'replay')
  assert.equal(kinds['Recording_2026-10-29T10-00-00-000Z_aaaa1111'], 'unfinished')
  assert.equal(kinds['Recording_2026-10-29T12-00-00-000Z_cccc3333.partial.mkv'], 'unfinished')
  assert.equal(kinds['notes.txt'], undefined)
  assert.equal(kinds[REPLAY_DIRECTORY], undefined, 'The replay ring is not a recording')
  const replay = entries.find(entry => entry.path === clip)
  assert.equal(replay.fps, 59.9)
  assert.equal(replay.codec, 'H.264 / NVIDIA NVENC')
  assert.equal(libraryPath(folder, clip), clip)
  assert.throws(() => libraryPath(folder, path.join(folder, 'notes.txt')), /not a recording/)
  assert.throws(() => libraryPath(folder, path.join(folder, '..', 'Recording_x.mp4')), /not a recording/)
  assert.throws(() => libraryPath(folder, path.join(folder, 'Recording_2026-10-29T10-00-00-000Z_aaaa1111')), /not a recording/,
    'Folders only where the action allows them')
  const sessionFolder = path.dirname(parts[0])
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(recoverUnfinished(sessionFolder, cancelled.signal), /Cancelled/)
  assert.ok(!(await fs.readdir(folder)).some(name => name.includes('_recovered')), 'a cancelled recovery leaves no file')
  const recovered = await recoverUnfinished(libraryPath(folder, sessionFolder, { folder: true }))
  assert.match(recovered.path, /_recovered\.mkv$/)
  assert.ok(Math.abs((await probeMedia(recovered.path)).seconds - 2) < 0.1)
  assert.equal((await fs.readdir(sessionFolder)).filter(name => name.endsWith('.mkv')).length, 2, 'recovery keeps the parts')
  const leftover = await captureParts(path.join('library', 'Recording_2026-10-29T13-00-00-000Z_dddd4444'), 1)
  await fs.copyFile(leftover.parts[0], `${leftover.folder}.mkv`)
  const listed = (await listLibrary(folder)).find(entry => entry.path === leftover.folder)
  assert.equal(listed.savedAs, 'Recording_2026-10-29T13-00-00-000Z_dddd4444.mkv', 'parts that outlived a save are leftovers, not a recording to recover')
  assert.equal(await uniqueOutput(clip, '_trim', '.mp4'), clip.replace('.mp4', '_trim.mp4'))
  await fs.writeFile(clip.replace('.mp4', '_trim.mp4'), '')
  assert.equal(await uniqueOutput(clip, '_trim', '.mp4'), clip.replace('.mp4', '_trim-2.mp4'))
})

test('fast trims start on the keyframe before the in point without re-encoding; exact trims start on the frame', async () => {
  const source = path.join(output, 'trim-source.mp4')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '0', '-c:a', 'aac', source])
  const keyframes = await keyframeTimes(source)
  assert.deepEqual(keyframes.map(t => Math.round(t * 1000) / 1000), [0, 1, 2, 3, 4])
  const count = async file => (await runFfmpeg(['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'framecrc', '-']))
    .split('\n').filter(line => /^0,/.test(line)).length
  const fast = path.join(output, `trim-fast-${Date.now()}.mp4`)
  const range = await trimRecording(source, fast, 2.4, 4, 'fast', { keyframes })
  assert.equal(range.start, 2)
  assert.ok(Math.abs(await count(fast) - 60) <= 1)
  const exact = path.join(output, `trim-exact-${Date.now()}.mp4`)
  await trimRecording(source, exact, 2.4, 4, 'exact')
  assert.ok(Math.abs(await count(exact) - 48) <= 1)
  assert.equal((await probeMedia(exact)).audio.length, 1)
  await assert.rejects(trimRecording(source, exact, 2.4, 4, 'exact'), /already exists/)
  const frame = await grabFrame(source, 1, 64, 36)
  assert.equal(frame.length, 64 * 36 * 4)
})

test('fit-to-size picks a legible size and frame rate and lands under the target', async () => {
  const plan = fitPlan({ seconds: 60, width: 2560, height: 1440, fps: 165 }, 10e6)
  assert.deepEqual([plan.width, plan.height, plan.fps], [960, 540, 30])
  const long = fitPlan({ seconds: 600, width: 1920, height: 1080, fps: 60 }, 500e6)
  assert.deepEqual([long.height, long.fps], [1080, 60])
  assert.throws(() => fitPlan({ seconds: 3600, width: 1920, height: 1080, fps: 60 }, 10e6), /too long/)
  const source = path.join(output, 'fit-source.mkv')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'aac', source])
  const target = 600_000
  const fitted = path.join(output, `fit-${Date.now()}.mp4`)
  const result = await fitToSize(source, fitted, target)
  const bytes = (await fs.stat(fitted)).size
  assert.ok(bytes <= target, `${bytes} bytes is over the ${target} target (${result.encoder})`)
  assert.ok(bytes > target * 0.5, 'and does not waste most of the budget')
  assert.equal(result.bytes, bytes)
  assert.ok((await probeMedia(fitted)).audio.length === 1)
})

// ---- Hardware: GPU capture on this machine's adapters ----

async function gpuDisplays(t) {
  if (process.platform !== 'win32' || !(await fs.stat(helper).catch(() => null))) { t.skip('The native helper is not built'); return [] }
  const displays = await withEncoders(await listNativeDisplays(helper))
  if (!displays.some(d => d.encoders?.h264)) { t.skip('No GPU encoder initialized on this machine'); return [] }
  return displays
}

test('GPU capture records a cropped region at the requested size through every working family on the display adapter', async t => {
  const displays = await gpuDisplays(t)
  const target = displays.find(d => d.encoders?.h264)
  if (!target) return
  const families = [target.encoders.h264, ...(target.vendorId === 0x10de ? ['mf'] : [])]
  for (const family of [...new Set(families)]) {
    const file = path.join(output, `gpu-${family}.mkv`)
    const region = { x: target.x + 64, y: target.y + 32, width: 640, height: 360 }
    const log = await runFfmpeg(['-y', '-v', 'info', ...captureDeviceArgs(target), '-filter_complex', captureGraph({ display: target, family, fps: 60, region }),
      '-map', '[v]', ...captureEncoderArgs(family, { nativeCodec: 'h264', qualityPreset: 'medium' }, 60, 640 * 360 * 60), '-frames:v', '30', file])
    assert.ok(openedExpectedAdapter(log, target), `${family} opened ${target.adapterName}`)
    const probe = await probeMedia(file)
    assert.deepEqual([probe.video.width, probe.video.height], [640, 360])
  }
})

test('instant replay saves a clip covering the requested length that ends after the save request', async t => {
  const displays = await gpuDisplays(t)
  const target = displays.find(d => d.encoders?.h264)
  if (!target) return
  const folder = path.join(output, 'replay-run')
  await fs.rm(folder, { recursive: true, force: true })
  const errors = []
  const replay = new ReplayBuffer({ display: target, family: target.encoders.h264 },
    { ...defaults, outputFolder: folder, systemAudio: false, frameRate: 30, replaySeconds: 30 }, () => {}, message => errors.push(message))
  await replay.start()
  await replay.waitUntilReady()
  await new Promise(resolve => setTimeout(resolve, 7000))
  const requested = Date.now()
  const saved = await replay.save()
  assert.ok(Date.now() - requested < 9000, 'the save waits at most for the current segment')
  assert.ok(saved.stats.seconds >= 6.5 && saved.stats.seconds <= 12, `clip is ${saved.stats.seconds} s`)
  assert.equal(saved.stats.pacing.nonMonotonicTimestamps, 0)
  assert.equal(saved.info.kind, 'replay')
  assert.match(path.basename(saved.path), /^Recording_.+_replay\.mp4$/)
  await replay.stop()
  await assert.rejects(fs.stat(path.join(folder, REPLAY_DIRECTORY, replay.id.slice(0, 8))), /ENOENT/, 'stop deletes the ring')
  assert.deepEqual(errors, [])
})
