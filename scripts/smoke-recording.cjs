// Windows hardware smoke test. Uses an isolated profile and writes only under
// .test-output; existing settings/recordings and installed apps are untouched.
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('close', code => { process.exitCode = code || 0 })
} else if (process.env.SLEEK_SMOKE_PROFILE) {
  // The second launch below: the single-instance lock must end this process without side effects.
  require('electron').app.setPath('userData', process.env.SLEEK_SMOKE_PROFILE)
  require(path.join(root, 'dist-electron/main.js'))
} else {
  const { app, BrowserWindow, shell } = require('electron')
  const directory = path.join(root, '.test-output', `smoke-${Date.now()}`)
  const profile = path.join(directory, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  // Verify with the same binary the app resolves, as the unit tests do.
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'electron/ffmpeg.ts')], bundle: true,
    platform: 'node', format: 'cjs', external: ['ffmpeg-static'], outfile: path.join(directory, 'ffmpeg.cjs') })
  const { ffmpegBinary } = require(path.join(directory, 'ffmpeg.cjs'))
  console.log(JSON.stringify({ ffmpeg: ffmpegBinary }))
  app.setPath('userData', profile)
  // Chromium's fake microphone plays a tone, so the separate-track recording has a real mic input.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    outputFolder: directory, qualityPreset: 'ultra', recordingEngine: 'native', frameRate: 165,
    nativeCodec: 'h264', systemAudio: true, micEnabled: false, columnCount: 2,
  }))
  shell.showItemInFolder = () => {}
  let showingMotion = false
  app.on('browser-window-created', (_event, window) => {
    if (showingMotion) return
    window.hide()
    window.minimize = () => window.hide()
    window.restore = () => window.hide()
    window.focus = () => {}
    window.show = () => {}
  })
  require(path.join(root, 'dist-electron/main.js'))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const watchdog = setTimeout(() => app.exit(2), 420000)
  let main
  const js = source => main.webContents.executeJavaScript(source)
  const api = (call) => js(`window.electronAPI.${call}`)
  async function until(condition, timeout = 30000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const text = await js('document.body.innerText')
      if (await js(`!!document.querySelector('[role="alert"]')`)) throw new Error(text)
      if (condition(text)) return text
      await sleep(200)
    }
    throw new Error('Timed out waiting for recording state: ' + await js('document.body.innerText'))
  }
  async function click(label) {
    const clicked = await js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.innerText===${JSON.stringify(label)});if(!b || b.disabled)return false;b.click();return true})()`)
    assert.ok(clicked, `Missing/enabled button: ${label}`)
  }
  async function start(marker) {
    await js(`Array.from(document.querySelectorAll('[role="tab"]')).find(b=>b.innerText==='Record')?.click()`)
    // Wait for the card itself: the header's "GPU capture ready on…" shows before any card loads.
    const card = `Array.from(document.querySelectorAll('main button')).find(b=>b.innerText.includes(${JSON.stringify(marker)}) && !b.disabled)`
    for (const began = Date.now(); !await js(`!!${card}`);) {
      if (Date.now() - began > 30000) throw new Error(`No enabled source card says "${marker}": ` + await js('document.body.innerText'))
      await sleep(200)
    }
    await js(`${card}.click()`)
    await until(text => text.includes('Stop and save') && !text.includes('Starting capture'))
  }
  async function savedPath(started) {
    const text = await until(text => text.includes('Saved:') && !text.includes('Finishing recording') && !text.includes('Making the MP4'), 120000)
    const file = text.match(/Saved: (.+)/)[1].trim()
    assert.ok(fs.statSync(file).size > 1000)
    console.log(JSON.stringify({ saved: file, stopMs: Date.now() - started }))
    return file
  }
  async function stop() {
    const started = Date.now()
    await click('Stop and save')
    return savedPath(started)
  }
  function packets(file) {
    const { execFileSync } = require('node:child_process')
    const crc = execFileSync(ffmpegBinary, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'framecrc', '-'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 50_000_000 })
    const last = new Map()
    let frames = 0
    for (const line of crc.split('\n')) {
      if (!/^\d+,/.test(line)) continue
      const [stream, dts] = line.split(',').map(Number)
      assert.ok(!last.has(stream) || dts > last.get(stream), `Non-monotonic timestamps in ${file}, stream ${stream}`)
      last.set(stream, dts)
      if (stream === 0) frames++
    }
    return { frames, streams: last.size }
  }
  ;(async () => {
    await app.whenReady()
    // The browser recorder receives a frame only when the screen changes; an idle desktop gave
    // about 19 frames where the check below needs 30. This corner counter keeps the screen moving.
    showingMotion = true
    const motion = new BrowserWindow({ width: 160, height: 60, x: 0, y: 0, frame: false, alwaysOnTop: true, focusable: false,
      skipTaskbar: true, show: false })
    showingMotion = false
    await motion.loadURL('data:text/html,<body style="margin:0;background:%23121212;color:%23BB86FC;font:28px monospace">' +
      '<script>let n=0;(function tick(){document.body.textContent=n++;requestAnimationFrame(tick)})()</script>')
    motion.showInactive()
    await sleep(1500)
    main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html') || window.webContents.getURL().endsWith('/'))
    assert.ok(main)
    const page = main.webContents.getURL()
    await js(`location.href = 'https://example.com/'`)
    await sleep(500)
    assert.equal(main.webContents.getURL(), page, 'No page may navigate away')
    assert.equal(await js(`window.open('https://example.com/')`), null, 'No page may open a window')
    await start('GPU capture')
    console.log('Native capture + system audio started')
    const intervals = Math.max(1, Math.ceil(Number(process.env.SLEEK_SMOKE_SECONDS || 60) / 10))
    for (let i = 0; i < intervals; i++) {
      await sleep(10000)
      await until(text => text.includes('Stop and save'))
      const memory = await main.webContents.executeJavaScript('performance.memory.usedJSHeapSize')
      console.log(JSON.stringify({ nativeSeconds: (i + 1) * 10, rendererHeapBytes: memory }))
    }
    const native = await stop()
    await start('GPU capture')
    await sleep(1500)
    await click('Pause')
    await until(text => text.includes('Resume') && !text.includes('Pausing'))
    await sleep(750)
    await click('Resume')
    await until(text => text.includes('Stop and save') && !text.includes('Resuming'))
    await sleep(1500)
    const joined = await stop()

    // A medium master becomes an MP4 on stop; separate tracks add game and microphone tracks.
    // From here on every recording, not a replay, gets an automatic compressed copy.
    await api(`saveSettings({qualityPreset:'medium',micEnabled:true,micTrack:'separate',micDeviceId:'unplugged',
      afterRecording:'compress',compression:{codec:'h264',quality:'small',maxHeight:720,maxFps:30}})`)
    main.reload()
    await sleep(2000)
    await assert.rejects(start('GPU capture'), /microphone is unavailable/, 'A missing microphone says so')
    await api(`saveSettings({micDeviceId:''})`)
    main.reload()
    await sleep(2000)
    await start('GPU capture')
    await sleep(4000)
    const tracks = await stop()
    assert.match(tracks, /\.mp4$/)
    // A recording that starts while the automatic copy encodes takes the encoder; the copy resumes after it.
    const compressed = file => file.replace(/\.\w+$/, '_compressed.mp4')
    const copyPartial = compressed(tracks).replace(/\.mp4$/, '.partial.mp4')
    for (let i = 0; i < 100 && !fs.existsSync(copyPartial) && !fs.existsSync(compressed(tracks)); i++) await sleep(50)
    await start('GPU capture')
    const yielded = !fs.existsSync(compressed(tracks))
    assert.ok(!fs.existsSync(copyPartial), 'A starting recording leaves no partial copy behind')
    await sleep(1500)
    const interrupting = await stop()
    console.log(JSON.stringify({ automaticCopyYielded: yielded }))

    // A first hotkey press with nothing remembered records the screen under the cursor and remembers it.
    await api(`saveSettings({micEnabled:false,lastSource:null})`)
    main.reload()
    await sleep(2000)
    const displays = require('electron').screen
    main.webContents.send('hotkey-record', displays.dipToScreenPoint(displays.getCursorScreenPoint()))
    await until(text => text.includes('Stop and save') && !text.includes('Starting capture'))
    assert.match((await api('getSettings()')).lastSource.id, /^screen:/, 'The first hotkey start is remembered')
    await sleep(1500)
    const firstUseStopped = Date.now()
    main.webContents.send('hotkey-record')
    const firstUse = await savedPath(firstUseStopped)
    console.log(JSON.stringify({ firstHotkeyPress: path.basename(firstUse) }))

    // Hotkey start of a remembered GPU region, then instant replay on it.
    const screen = (await api('getSources()')).find(source => source.nativeDisplay)
    const region = { x: screen.nativeDisplay.x + 128, y: screen.nativeDisplay.y + 64, width: 640, height: 360 }
    await api(`saveSettings({micEnabled:false,lastSource:${JSON.stringify({ id: screen.id, name: 'Smoke area', region })}})`)
    main.reload()
    await sleep(2000)
    main.webContents.send('hotkey-record')
    await until(text => text.includes('Stop and save') && !text.includes('Starting capture'))
    await sleep(3000)
    const hotkeyStopped = Date.now()
    main.webContents.send('hotkey-record')
    const area = await savedPath(hotkeyStopped)
    main.webContents.send('hotkey-replay-toggle')
    await until(text => text.includes('buffered'))
    await sleep(7000)
    const secondLaunch = require('node:child_process').spawn(process.execPath, [__filename], {
      env: { ...process.env, SLEEK_SMOKE_PROFILE: profile }, windowsHide: true, stdio: 'ignore' })
    await new Promise(resolve => secondLaunch.on('close', resolve))
    assert.notDeepEqual(fs.readdirSync(path.join(directory, '.sleekrec-replay')), [], 'A second launch leaves the armed replay alone')
    const replay = await api('replaySave()')
    console.log(JSON.stringify({ replay: replay.path, seconds: replay.stats.seconds }))
    main.webContents.send('hotkey-replay-toggle')
    await until(text => !text.includes('buffered'))
    await sleep(1000)
    assert.deepEqual(fs.readdirSync(path.join(directory, '.sleekrec-replay')), [], 'Turning replay off deletes its ring')

    await api(`saveSettings({recordingEngine:'browser',frameRate:60,qualityPreset:'high',lastSource:null})`)
    main.reload()
    await sleep(1500)
    await start('Browser capture')
    await sleep(2000)
    await click('Pause')
    await until(text => text.includes('Resume'))
    await click('Resume')
    await sleep(1500)
    const browser = await stop()

    const expectations = new Map([[native, { streams: 2, ultra: true }], [joined, { streams: 2, ultra: true }],
      [tracks, { streams: 4 }], [area, { streams: 2, size: [640, 360] }], [replay.path, { streams: 2, size: [640, 360], kind: 'replay' }],
      [browser, { streams: 2 }]])
    for (const [file, expected] of expectations) {
      const { frames, streams } = packets(file)
      assert.ok(frames > 30, `${file}: ${frames} frames`)
      assert.equal(streams, expected.streams, `${file}: video plus ${expected.streams - 1} audio tracks`)
      const report = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'))
      assert.equal(report.stats.pacing.frames, frames, 'Sidecar must count actual encoded packets')
      assert.equal(report.stats.pacing.nonMonotonicTimestamps, 0)
      assert.ok(report.info.sourceId.startsWith('screen:'))
      if (expected.ultra) assert.equal(report.info.quality, 'lossless-444')
      if (expected.size) assert.deepEqual([report.info.width, report.info.height], expected.size)
      if (expected.kind) assert.equal(report.info.kind, expected.kind)
      if (file !== browser) assert.match(report.info.codec, /NVENC|AMF|Quick Sync|Media Foundation/)
      console.log(JSON.stringify({ checked: path.basename(file), frames, streams, timestamps: 'strictly increasing' }))
    }
    // One verified automatic copy per recording saved since the setting, next to its kept master; none for the replay.
    const masters = [tracks, interrupting, area, browser]
    for (let i = 0; i < 600 && !masters.every(file => fs.existsSync(`${compressed(file)}.json`)); i++) await sleep(100)
    await sleep(500) // The job ends just after it writes the sidecar.
    for (const master of masters) {
      const sidecar = JSON.parse(fs.readFileSync(`${compressed(master)}.json`, 'utf8'))
      assert.equal(sidecar.derivedFrom, master)
      assert.ok(fs.existsSync(master), `${master} is kept`)
      assert.ok(sidecar.height <= 720, `${compressed(master)} is capped at 720p`)
    }
    assert.ok(!fs.existsSync(compressed(replay.path)), 'Replay saves get no automatic copy')
    console.log(JSON.stringify({ automaticCopies: masters.map(file => ({ copy: path.basename(compressed(file)),
      masterBytes: fs.statSync(file).size, copyBytes: fs.statSync(compressed(file)).size })) }))
    const library = await api('listRecordings()')
    for (const file of expectations.keys()) assert.ok(library.some(entry => entry.path === file), `Library lists ${file}`)
    const details = await api(`mediaDetails(${JSON.stringify(tracks)})`)
    assert.match(details.thumbnail, /^data:image\/jpeg;base64,/)
    assert.deepEqual(details.audioTracks, ['Game + microphone', 'Game', 'Microphone'])
    const trimmed = await api(`trimRecording(${JSON.stringify(tracks)}, 1, 3, 'fast')`)
    assert.equal(packets(trimmed).streams, 4, 'A fast trim keeps every track')
    const fitted = await api(`exportRecording(${JSON.stringify(tracks)}, {mode:'fit',targetMB:10})`)
    assert.ok(fs.statSync(fitted).size <= 10_000_000)
    console.log(JSON.stringify({ trimmed: path.basename(trimmed), fitted: path.basename(fitted), fittedBytes: fs.statSync(fitted).size }))
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ native, joined, tracks, area, replay: replay.path, browser, trimmed, fitted }, null, 2))
    console.log('SMOKE PASS', directory)
    clearTimeout(watchdog)
    app.quit()
  })().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
}
