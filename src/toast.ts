// Hotkey feedback shown over games; main positions, shows and hides the window.
import './index.css'

const dot = document.getElementById('dot')!
const text = document.getElementById('message')!

window.electronAPI.onToast(({ message, tone }) => {
  text.textContent = message
  dot.classList.toggle('bg-primary', tone !== 'error')
  dot.classList.toggle('bg-red-500', tone === 'error')
})
