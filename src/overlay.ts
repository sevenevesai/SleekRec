// Recording overlay: a static page so the always-on-top window does not load React.
// State changes toggle classes on the markup in overlay.html; replacing elements would drop
// clicks that span one of the 500 ms timer updates.
import './index.css'

const byId = (id: string) => document.getElementById(id)!
const toggle = (element: Element, classes: string, on: boolean) =>
  classes.split(' ').forEach(name => element.classList.toggle(name, on))

const formatTime = (seconds: number) => {
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const pause = byId('pause')
const mic = byId('mic')
const fps = byId('fps')

window.electronAPI.onTimerUpdate(data => {
  byId('timer').textContent = formatTime(data.timer)
  toggle(byId('dot'), 'bg-yellow-500', data.isPaused)
  toggle(byId('dot'), 'bg-red-500', !data.isPaused)
  pause.title = data.isPaused ? 'Resume' : 'Pause'
  toggle(byId('pause-icon'), 'hidden', data.isPaused)
  toggle(byId('resume-icon'), 'hidden', !data.isPaused)
  toggle(mic, 'hidden', !data.hasMic)
  toggle(mic, 'bg-red-500/20 hover:bg-red-500/30', data.isMicMuted)
  toggle(mic, 'bg-primary/20 hover:bg-primary/30', !data.isMicMuted)
  mic.title = data.isMicMuted ? 'Unmute mic' : 'Mute mic'
  toggle(byId('mic-on'), 'hidden', data.isMicMuted)
  toggle(byId('mic-off'), 'hidden', !data.isMicMuted)
})
window.electronAPI.onRecordingStats(stats => {
  fps.textContent = `${Math.round(stats.fps)} fps encoded`
  toggle(fps, 'text-yellow-400', !!stats.warning)
  toggle(fps, 'text-gray-400', !stats.warning)
  fps.classList.remove('hidden')
})

pause.addEventListener('click', () => window.electronAPI.overlayPause())
mic.addEventListener('click', () => window.electronAPI.overlayMicToggle())
byId('stop').addEventListener('click', () => window.electronAPI.overlayStop())
