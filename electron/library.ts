import fs from 'node:fs/promises'
import path from 'node:path'
import { LibraryEntry, LibraryKind, SavedRecording } from '../src/recording'
import { REPLAY_DIRECTORY } from './replay-buffer'
import { runFfmpeg } from './ffmpeg'
import { writeNew } from './export-recording'

// Kept free of Electron imports so scripts/test-recording.cjs can exercise listing and recovery.

const MEDIA = /^Recording_.+\.(mp4|mkv|webm)$/i
const PARTIAL = /\.partial\.(mp4|mkv|webm)$/i
const SESSION_FOLDER = /^Recording_[^.]+$/

/** Sidecar written next to trims and exports, so the panel can say what they came from. */
export interface DerivedSidecar {
  path: string
  derivedFrom: string
  operation: 'trim' | 'export'
  detail: string
  seconds?: number
  width?: number
  height?: number
}

/**
 * Resolves a renderer-supplied path and refuses anything outside the output folder or not
 * named like a recording, so IPC callers cannot open, delete or serve arbitrary files.
 */
export function libraryPath(outputFolder: string, file: unknown, options: { folder?: boolean } = {}): string {
  if (typeof file !== 'string') throw new Error('Invalid recording path')
  const resolved = path.resolve(file)
  const relative = path.relative(path.resolve(outputFolder), resolved)
  const name = path.basename(resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) ||
    !(MEDIA.test(name) || (options.folder && SESSION_FOLDER.test(name)))) {
    throw new Error('That file is not a recording in the output folder')
  }
  return resolved
}

function kindFromName(name: string): LibraryKind {
  if (/_replay(-\d+)?\./.test(name)) return 'replay'
  if (/_trim(-\d+)?\./.test(name)) return 'trim'
  if (/_(export|smaller|fit-\d+MB|compatible)(-\d+)?\./.test(name)) return 'export'
  return 'recording'
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch { return undefined } // A missing or damaged sidecar only loses the extra details.
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const str = (value: unknown) => typeof value === 'string' ? value : undefined

function fromSidecar(entry: LibraryEntry, sidecar: Record<string, unknown>): void {
  const info = sidecar.info as Record<string, unknown> | undefined
  const stats = sidecar.stats as Record<string, unknown> | undefined
  const pacing = stats?.pacing as Record<string, unknown> | undefined
  if (str(sidecar.derivedFrom)) {
    entry.derivedFrom = path.basename(str(sidecar.derivedFrom)!)
    entry.kind = sidecar.operation === 'trim' ? 'trim' : 'export'
    entry.seconds = num(sidecar.seconds)
    entry.width = num(sidecar.width)
    entry.height = num(sidecar.height)
    entry.codec = str(sidecar.detail)
    return
  }
  if (info) {
    if (info.kind === 'replay') entry.kind = 'replay'
    entry.engine = info.engine === 'native' ? 'native' : info.engine === 'browser' ? 'browser' : undefined
    entry.width = num(info.width)
    entry.height = num(info.height)
    entry.codec = str(info.codec)
    if (Array.isArray(info.audioTracks)) entry.audioTracks = info.audioTracks.filter((t): t is string => typeof t === 'string')
  }
  entry.seconds = num(stats?.seconds)
  entry.fps = num(pacing?.averageFps)
  entry.gapsOver100ms = num(pacing?.gapsOver100ms)
  entry.warning = str(sidecar.warning)
}

/** Recordings, replays, trims and exports in the output folder, newest first, plus unfinished sessions. */
export async function listLibrary(outputFolder: string): Promise<LibraryEntry[]> {
  const dirents = await fs.readdir(outputFolder, { withFileTypes: true }).catch(() => [])
  const entries: LibraryEntry[] = []
  for (const dirent of dirents) {
    const file = path.join(outputFolder, dirent.name)
    try {
      const entry = await libraryEntry(file, dirent)
      if (entry) entries.push(entry)
    } catch (error) {
      // A replay or job renames its .partial file between readdir and stat; that entry is skipped.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return entries.sort((a, b) => b.modifiedMs - a.modifiedMs)
}

async function libraryEntry(file: string, dirent: { name: string; isDirectory(): boolean; isFile(): boolean }): Promise<LibraryEntry | undefined> {
  if (dirent.isDirectory()) {
    if (dirent.name === REPLAY_DIRECTORY || !SESSION_FOLDER.test(dirent.name)) return undefined
    const parts = (await fs.readdir(file).catch(() => [] as string[])).filter(name => /^part-\d+\.mkv$/.test(name))
    if (!parts.length) return undefined
    const stats = await Promise.all(parts.map(part => fs.stat(path.join(file, part))))
    // Parts that outlived a successful save (their deletion failed) are leftovers, not a recording to recover.
    const saved = await Promise.all(['.mp4', '.mkv'].map(ext => fs.access(file + ext).then(() => path.basename(file + ext), () => '')))
    return { path: file, name: dirent.name, kind: 'unfinished', container: 'mkv', parts: parts.length,
      bytes: stats.reduce((sum, stat) => sum + stat.size, 0), modifiedMs: Math.max(...stats.map(stat => stat.mtimeMs)),
      ...(saved.find(Boolean) ? { savedAs: saved.find(Boolean) } : {}) }
  }
  if (!dirent.isFile() || !MEDIA.test(dirent.name)) return undefined
  const stat = await fs.stat(file)
  const container = path.extname(dirent.name).slice(1).toLowerCase()
  if (PARTIAL.test(dirent.name)) {
    // Browser captures in progress or interrupted; FFmpeg's own .partial.mp4 outputs are not recordings.
    return container !== 'mp4' ? { path: file, name: dirent.name, kind: 'unfinished', container, bytes: stat.size, modifiedMs: stat.mtimeMs } : undefined
  }
  const entry: LibraryEntry = { path: file, name: dirent.name, kind: kindFromName(dirent.name), container,
    bytes: stat.size, modifiedMs: stat.mtimeMs }
  const sidecar = await readJson(`${file}.json`)
  if (sidecar) fromSidecar(entry, sidecar)
  return entry
}

/** `<base><suffix><ext>`, or with -2, -3… when that name exists. Never an existing file. */
export async function uniqueOutput(source: string, suffix: string, extension: string): Promise<string> {
  const base = source.replace(/\.[^.\\/]+$/, '').replace(/\.partial$/, '')
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}${suffix}${n > 1 ? `-${n}` : ''}${extension}`
    const taken = await Promise.all([candidate, `${candidate}.json`].map(file => fs.access(file).then(() => true, () => false)))
    if (!taken.some(Boolean)) return candidate
  }
  throw new Error('Too many copies with this name already exist')
}

/**
 * Joins an interrupted capture without deleting it: the parts of a native session folder, or
 * a browser .partial file. Output goes through a .partial name, so a cancelled or failed
 * recovery leaves no truncated file that would list as a recording. The caller moves the
 * originals to the recycle bin after success.
 */
export async function recoverUnfinished(file: string, signal?: AbortSignal): Promise<SavedRecording> {
  const stat = await fs.stat(file)
  let output: string
  if (stat.isDirectory()) {
    const parts = (await fs.readdir(file)).filter(name => /^part-\d+\.mkv$/.test(name)).sort()
    if (!parts.length) throw new Error('No recording parts remain in this folder')
    output = await uniqueOutput(file + '.mkv', '_recovered', '.mkv')
    const manifest = path.join(file, 'recover.ffconcat')
    await fs.writeFile(manifest, 'ffconcat version 1.0\n' + parts.map(name => `file '${name}'`).join('\n') + '\n')
    try {
      // A crash can cut the last cluster; FFmpeg copies every complete packet before it.
      await writeNew(output, partial => runFfmpeg(['-n', '-err_detect', 'ignore_err', '-f', 'concat', '-safe', '1', '-i', manifest,
        '-map', '0', '-c', 'copy', partial], 0, undefined, signal))
    } finally {
      await fs.unlink(manifest).catch(() => {}) // The manifest is ours; parts stay untouched.
    }
  } else {
    const h264 = /\.partial\.mkv$/i.test(file)
    output = await uniqueOutput(file.replace(PARTIAL, `.${h264 ? 'mp4' : 'webm'}`), '_recovered', h264 ? '.mp4' : '.webm')
    await writeNew(output, partial => runFfmpeg(['-n', '-err_detect', 'ignore_err', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy',
      ...(h264 ? ['-c:a', 'aac', '-movflags', '+faststart'] : ['-c:a', 'copy']), partial], 0, undefined, signal))
  }
  const result: SavedRecording = { path: output, info: { engine: stat.isDirectory() ? 'native' : 'browser', codec: 'recovered', width: 0, height: 0, targetFps: 0 },
    warning: 'Recovered from an interrupted recording; the last second may be missing.' }
  return result
}
