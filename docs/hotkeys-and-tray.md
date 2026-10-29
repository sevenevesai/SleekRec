# Hotkeys, tray and startup

Starting, stopping and saving from inside a game, without touching SleekRec's window. Code:
`electron/hotkeys.ts`, `electron/tray.ts`, `electron/settings.ts` (validation), the hotkey and
tray wiring in `electron/main.ts`, and `handleHotkeyRecord` / `handleReplayToggle` in `src/App.tsx`.

## Hotkeys

| Action | Default | Notes |
|---|---|---|
| Start or stop recording | Ctrl+Shift+F8 | Records the remembered source |
| Stop and save | Ctrl+Shift+F9 | |
| Pause or resume | Ctrl+Shift+F10 | |
| Save instant replay | Ctrl+Shift+F7 | Handled in main; toast on success or failure |
| Instant replay on/off | none | Arms the remembered source |

Defaults avoid Alt+F9/Alt+F10, which the NVIDIA App holds. All five are configurable in Settings.
`isValidHotkey` accepts Electron accelerators where letters, digits and punctuation need a
modifier, so a hotkey never swallows typing in other apps; function, media and Print Screen keys
may stand alone. A duplicate accelerator is cleared, not shared. `globalShortcut.register`
returning false means another app holds the combination; Settings shows "In use by another app".
While a hotkey field listens for keys, SleekRec releases its hotkeys so the combination being
typed does not fire.

## Remembered source

Every start from the picker, and every replay arm, stores a `SourceRef` (`lastSource`): the
desktopCapturer ID, a label, and the region or window-area flag. A hotkey or tray start refreshes
the sources and looks it up by ID; a window whose handle changed (the app restarted) matches only
a unique exact title. When nothing matches, a toast says so and the window opens. A hotkey never
picks a different source.

Hotkey and tray starts happen inside games, so their session is marked `origin: 'hotkey'`: stop
shows a toast instead of restoring SleekRec's window. UI starts restore it and open the
Recordings tab. Toasts (`toast.html`) are click-through, always on top and excluded from capture;
Windows suppresses notifications during fullscreen games.

## Tray

The tray icon is drawn in code at 16, 24 and 32 px (premultiplied BGRA): an accent ring with a
state mark for idle, recording (red), paused (yellow bars) and replay armed (teal). Its menu
starts the remembered source or stops, pauses, turns replay on/off and saves it, shows the
window or the Recordings tab, opens the folder, and quits. State follows `sync-timer` pauses and
replay arm/disarm.

## Startup

- A single-instance lock focuses the running window on a second launch.
- **Start minimized to the tray** creates the window hidden; launches with `--hidden` (the login
  item) do the same.
- **Keep running in the tray when the window closes** hides instead of closing; quit from the
  tray. A recording or job still blocks close and stops first, as before.
- **Start SleekRec when you sign in** sets the login item with `--hidden`, only in packaged builds
  (a development build would register electron.exe).
