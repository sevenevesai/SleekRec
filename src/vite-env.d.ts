/// <reference types="vite/client" />

interface Window {
  electronAPI: {
    getSources: () => Promise<{id: string, name: string, thumbnail: string}[]>
    startSave: () => void
    saveChunk: (chunk: ArrayBuffer) => void
    stopSave: () => Promise<string>
    minimize: () => void
    restore: () => void
  }
}
