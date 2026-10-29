const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') process.exit(0)
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'native', 'windows-displays.cpp')
const output = path.join(root, 'native', 'bin', 'windows-displays.exe')
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) process.exit(0)
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
try {
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
  { encoding: 'utf8', windowsHide: true }).trim()
  if (!installation) throw new Error('Visual C++ build tools were not found')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const setup = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  // Only compilation runs in cmd; filesystem operations above use Node APIs.
  const batch = path.join(path.dirname(output), 'compile.cmd')
  fs.writeFileSync(batch, `@echo off\r\ncall "${setup}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /EHsc /O2 /MT /std:c++17 "${source}" /Fe:"${output}" /Fo:"${output}.obj" /link dxgi.lib dwmapi.lib user32.lib\r\n`)
  execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${batch}"`],
    { cwd: root, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
} catch (error) {
  console.error('Native display helper build failed. Install Visual Studio C++ Build Tools and the Windows SDK.')
  console.error(error.message)
  process.exit(1)
}
