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
} else {
  const { app, BrowserWindow, shell } = require('electron')
  const directory = path.join(root, '.test-output', `smoke-${Date.now()}`)
  const profile = path.join(directory, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    outputFolder: directory, qualityPreset: 'ultra', recordingEngine: 'native', frameRate: 165,
    nativeCodec: 'h264', systemAudio: true, micEnabled: false, columnCount: 2,
  }))
  shell.showItemInFolder = () => {}
  app.on('browser-window-created', (_event, window) => {
    window.hide()
    window.minimize = () => window.hide()
    window.restore = () => window.hide()
    window.focus = () => {}
  })
  require(path.join(root, 'dist-electron/main.js'))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const watchdog = setTimeout(() => app.exit(2), 150000)
  let main
  const js = source => main.webContents.executeJavaScript(source)
  async function until(condition, timeout = 20000) {
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
    await until(text => text.includes(marker))
    assert.ok(await js(`(()=>{const b=Array.from(document.querySelectorAll('main button')).find(b=>b.innerText.includes(${JSON.stringify(marker)}));if(!b || b.disabled)return false;b.click();return true})()`))
    await until(text => text.includes('Stop and save') && !text.includes('Starting capture'))
  }
  async function stop() {
    const started = Date.now()
    await click('Stop and save')
    const text = await until(text => text.includes('Saved:') && !text.includes('Finishing recording'))
    const file = text.match(/Saved: (.+)/)[1].trim()
    assert.ok(fs.statSync(file).size > 1000)
    console.log(JSON.stringify({ saved: file, stopMs: Date.now() - started }))
    return file
  }
  ;(async () => {
    await app.whenReady()
    await sleep(1500)
    main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('#overlay'))
    assert.ok(main)
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
    await js(`window.electronAPI.saveSettings({recordingEngine:'browser',frameRate:60,qualityPreset:'high'})`)
    main.reload()
    await sleep(1500)
    await start('Browser capture')
    await sleep(2000)
    await click('Pause')
    await until(text => text.includes('Resume'))
    await click('Resume')
    await sleep(1500)
    const browser = await stop()
    const { execFileSync } = require('node:child_process')
    for (const file of [native, joined, browser]) {
      const packets = execFileSync(require('ffmpeg-static'), ['-hide_banner', '-v', 'error', '-i', file,
        '-map', '0', '-c', 'copy', '-f', 'framecrc', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 10_000_000 })
      const last = new Map()
      let frames = 0
      for (const line of packets.split('\n')) {
        if (!/^\d+,/.test(line)) continue
        const [stream, dts] = line.split(',').map(Number)
        assert.ok(!last.has(stream) || dts > last.get(stream), `Non-monotonic timestamps in ${file}, stream ${stream}`)
        last.set(stream, dts)
        if (stream === 0) frames++
      }
      assert.ok(frames > 30)
      assert.equal(last.size, 2, 'Video and system audio must both be present')
      const report = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'))
      assert.equal(report.stats.pacing.frames, frames, 'Sidecar must count actual encoded packets')
      assert.equal(report.stats.pacing.nonMonotonicTimestamps, 0)
      assert.ok(report.info.sourceId.startsWith('screen:'))
      if (file !== browser) assert.equal(report.info.quality, 'lossless-444')
      console.log(JSON.stringify({ checked: file, frames, timestamps: 'strictly increasing' }))
    }
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ native, joined, browser }, null, 2))
    console.log('SMOKE PASS', directory)
    clearTimeout(watchdog)
    app.quit()
  })().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
}
