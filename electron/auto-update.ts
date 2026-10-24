import { app, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'

// Downloads the newest GitHub release for electron-updater to install when the app quits.
// Windows updates run the NSIS setup, which would put a second copy beside an MSI install; only
// NSIS installs ship this uninstaller. macOS is left out: Squirrel.Mac refuses updates for apps
// without a Developer ID signature, and the macOS builds are unsigned. Linux updates AppImages.
export async function updateOnQuit(): Promise<void> {
  if (process.platform === 'win32') {
    if (!fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall SleekRec.exe'))) return
    // Toasts only show for the AUMID the NSIS shortcuts carry, which is the build appId.
    app.setAppUserModelId('com.sleek.recorder')
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
