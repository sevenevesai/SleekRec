// npm installs ffmpeg-static for the build machine only, and one macOS runner packages both
// architectures, so without this the other architecture's app ships an FFmpeg it cannot execute.
// afterPack runs before electron-builder signs, so the replacement binary is signed with the app.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('electron-builder')

const MACH_O_CPU = { x64: 0x01000007, arm64: 0x0100000c }

function machOCpu(file) {
  const header = Buffer.alloc(8)
  const descriptor = fs.openSync(file, 'r')
  try { fs.readSync(descriptor, header, 0, 8, 0) } finally { fs.closeSync(descriptor) }
  if (header.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`${file} is not a 64-bit Mach-O binary`)
  return header.readUInt32LE(4)
}

module.exports = async function afterPack({ electronPlatformName, arch, appOutDir, packager }) {
  if (electronPlatformName !== 'darwin') return
  const archName = Arch[arch]
  const expected = MACH_O_CPU[archName]
  if (!expected) throw new Error(`No FFmpeg is available for macOS ${archName}`)
  const binary = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources',
    'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg')
  if (machOCpu(binary) === expected) return
  fs.rmSync(binary)
  // The installer skips a binary that already exists, and writes where FFMPEG_BIN points.
  execFileSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], {
    stdio: 'inherit',
    env: { ...process.env, npm_config_platform: 'darwin', npm_config_arch: archName, FFMPEG_BIN: binary },
  })
  if (machOCpu(binary) !== expected) throw new Error(`${binary} is still not a ${archName} binary`)
}
