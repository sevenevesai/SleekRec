import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  startSave: () => ipcRenderer.send('start-save-stream'),
  saveChunk: (chunk: ArrayBuffer) => ipcRenderer.send('save-chunk', chunk),
  stopSave: () => ipcRenderer.invoke('stop-and-save'),
  minimize: () => ipcRenderer.send('minimize-window'),
  restore: () => ipcRenderer.send('restore-window')
})
