const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const output = path.join(root, '.test-output', 'unit')
buildSync({ entryPoints: [path.join(root, 'electron/browser-recorder.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['ffmpeg-static'], outfile: path.join(output, 'browser.cjs') })
buildSync({ entryPoints: [path.join(root, 'electron/ffmpeg.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['ffmpeg-static'], outfile: path.join(output, 'ffmpeg.cjs') })
const { BrowserRecorder } = require(path.join(output, 'browser.cjs'))
const { runFfmpeg } = require(path.join(output, 'ffmpeg.cjs'))
buildSync({ entryPoints: [path.join(root, 'electron/export-recording.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['ffmpeg-static'], outfile: path.join(output, 'export.cjs') })
const { exportRecording } = require(path.join(output, 'export.cjs'))
buildSync({ entryPoints: [path.join(root, 'electron/pcm-matroska.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(output, 'pcm.cjs') })
const { pcmHeader, pcmPacket, pcmAudioFilter } = require(path.join(output, 'pcm.cjs'))
buildSync({ entryPoints: [path.join(root, 'electron/frame-pacing.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(output, 'pacing.cjs') })
const { FramePacingMeter } = require(path.join(output, 'pacing.cjs'))
buildSync({ entryPoints: [path.join(root, 'electron/native-recorder.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['ffmpeg-static'], outfile: path.join(output, 'native.cjs') })
const { nativeEncoderArgs } = require(path.join(output, 'native.cjs'))
buildSync({ entryPoints: [path.join(root, 'src/recording.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(output, 'settings.cjs') })
const { captureEngineForSource, requestedFps } = require(path.join(output, 'settings.cjs'))
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
    await runFfmpeg(['-y', '-i', input, ...nativeEncoderArgs({ ...settings, nativeCodec: codec }, 165), encoded])
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
