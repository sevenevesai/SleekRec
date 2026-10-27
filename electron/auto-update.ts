import { app, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Gatekeeper's Developer ID requirement; the leading "=" makes codesign read it as text, not a path.
const DEVELOPER_ID_REQUIREMENT =
  '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

// Downloads the newest GitHub release for electron-updater to install when the app quits.
// Windows updates run the NSIS setup, which would put a second copy beside an MSI install; only
// NSIS installs ship this uninstaller. macOS updates go through Squirrel.Mac, which refuses apps
// without a Developer ID signature, and CI builds unsigned apps when the Apple secrets are absent.
// Linux updates AppImages, and .deb installs through dpkg behind a pkexec/sudo prompt: the
// package-type file electron-builder writes into the .deb selects electron-updater's DebUpdater.
export async function updateOnQuit(): Promise<void> {
  if (process.platform === 'win32') {
    if (!fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall SleekRec.exe'))) return
    // Toasts only show for the AUMID the NSIS shortcuts carry, which is the build appId.
    app.setAppUserModelId('com.sleek.recorder')
  } else if (process.platform === 'darwin') {
    if (!(await hasDeveloperIdSignature())) return
  } else if (process.platform !== 'linux') {
    return
  }
  const update = await autoUpdater.checkForUpdates()
  if (!update?.downloadPromise) return
  await update.downloadPromise
  new Notification({
    title: 'SleekRec update ready',
    body: `Version ${update.updateInfo.version} installs when you quit SleekRec.`,
  }).show()
}

function hasDeveloperIdSignature(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, '../../..')
  const args = ['--verify', '--test-requirement', DEVELOPER_ID_REQUIREMENT, bundle]
  return new Promise(resolve => {
    execFile('/usr/bin/codesign', args, (error, _stdout, stderr) => {
      if (error) console.log('In-app updates are off: no valid Developer ID signature.', stderr.trim())
      resolve(!error)
    })
  })
}
