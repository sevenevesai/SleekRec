import { globalShortcut } from 'electron'
import { HotkeyAction, Hotkeys } from '../src/recording'

export type HotkeyStatus = Partial<Record<HotkeyAction, 'unavailable'>>

let registered: string[] = []

/**
 * Registers SleekRec's global hotkeys. globalShortcut.register returns false when another
 * application already holds the combination; the settings show those as unavailable.
 */
export function applyHotkeys(hotkeys: Hotkeys, handlers: Partial<Record<HotkeyAction, () => void>>): HotkeyStatus {
  releaseHotkeys()
  const status: HotkeyStatus = {}
  for (const action of Object.keys(handlers) as HotkeyAction[]) {
    const accelerator = hotkeys[action]
    const handler = handlers[action]
    if (!accelerator || !handler) continue
    let ok = false
    try { ok = globalShortcut.register(accelerator, handler) } catch { ok = false } // Reported as unavailable.
    if (ok) registered.push(accelerator)
    else status[action] = 'unavailable'
  }
  return status
}

/** While a hotkey field is recording keys, its combination must not trigger the action. */
export function releaseHotkeys(): void {
  for (const accelerator of registered) globalShortcut.unregister(accelerator)
  registered = []
}
