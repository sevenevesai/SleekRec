import { randomUUID } from 'node:crypto'
import { AppSettings, ExportRequest, JobProgress, SavedRecording } from '../src/recording'
import { JobOptions } from './export-recording'
import { CancelledError } from './ffmpeg'

// Kept free of Electron imports so scripts/test-recording.cjs can check the queue rules.

/** What to queue after a recording saved. Replay saves and unfinished partials never queue a job. */
export function automaticRequest(settings: Pick<AppSettings, 'afterRecording' | 'compression' | 'fitTargetMB'>,
  saved: SavedRecording): ExportRequest | undefined {
  if (saved.info.kind === 'replay' || /\.partial\.\w+$/i.test(saved.path)) return undefined
  if (settings.afterRecording === 'compress') return { mode: 'compress', options: settings.compression }
  if (settings.afterRecording === 'fit') return { mode: 'fit', targetMB: settings.fitTargetMB }
  return undefined
}

export interface AutomaticJob {
  label: string
  run: (options: JobOptions) => Promise<void>
}

interface Running {
  id: string
  label: string
  automatic: boolean
  controller: AbortController
  /** Why it was aborted. Cancel beats yield, so a cancelled job is never requeued. */
  stop?: 'cancel' | 'yield' | 'quit'
  ended: Promise<void>
  end: () => void
}

export interface JobQueueHooks {
  /** False while a recording holds the encoder or the app is quitting. */
  canStartAutomatic: () => boolean
  progress: (update: JobProgress & { done?: boolean }) => void
  /** After every job, whatever its outcome. */
  settled: () => void
  /** An automatic job failed or was cancelled from the UI. It is not retried. */
  automaticEnded: (job: AutomaticJob, error: Error, cancelled: boolean) => void
}

/**
 * One job at a time. Manual jobs (exports, trims, recoveries) run at once or are refused.
 * Automatic jobs wait in memory and give way to recordings, because a second encoder session
 * competes with live capture.
 */
export class JobQueue {
  private pending: AutomaticJob[] = []
  private running: Running | null = null

  constructor(private readonly hooks: JobQueueHooks) {}

  get manualRunning(): boolean { return !!this.running && !this.running.automatic }
  get automaticQueued(): number { return this.pending.length + (this.running?.automatic ? 1 : 0) }

  async run<T>(label: string, work: (options: JobOptions) => Promise<T>): Promise<T> {
    if (this.running) {
      throw new Error(this.running.automatic ? 'An automatic compression is running. Cancel it or wait for it to finish.'
        : 'Finish the current recording or export first')
    }
    const running = this.begin(label, false)
    try {
      return await work(this.options(running))
    } catch (error) {
      if (error instanceof CancelledError) throw new Error(`${label.replace(/…$/, '')} cancelled`)
      throw error
    } finally {
      this.finish(running)
    }
  }

  enqueue(job: AutomaticJob): void {
    this.pending.push(job)
    this.startPending()
  }

  /** Starts the next automatic job when nothing runs and the hooks allow it. */
  startPending(): void {
    if (this.running || !this.pending.length || !this.hooks.canStartAutomatic()) return
    const job = this.pending.shift()!
    this.runAutomatic(job).catch(error => console.error('Automatic job reporting failed:', error))
  }

  /**
   * Makes way for a recording that is starting: aborts a running automatic job, waits until
   * FFmpeg has exited and its partial output is removed, and puts the job back at the front.
   * A manual job is not touched; recordings are refused while one runs.
   */
  async yieldToRecording(): Promise<void> {
    const running = this.running
    if (!running?.automatic) return
    running.stop ??= 'yield'
    running.controller.abort()
    await running.ended
  }

  /** The panel's Cancel: ends the running job for good. */
  cancel(): void {
    if (!this.running) return
    if (this.running.stop !== 'quit') this.running.stop = 'cancel'
    this.running.controller.abort()
  }

  /** For quitting: drops pending automatic jobs, aborts a running one and waits for it to end. */
  async discardAutomatic(): Promise<void> {
    this.pending = []
    const running = this.running
    if (!running?.automatic) return
    running.stop = 'quit'
    running.controller.abort()
    await running.ended
  }

  private async runAutomatic(job: AutomaticJob): Promise<void> {
    const running = this.begin(job.label, true)
    try {
      await job.run(this.options(running))
    } catch (error) {
      const cancelled = error instanceof CancelledError
      if (cancelled && running.stop === 'yield') this.pending.unshift(job)
      else if (running.stop !== 'quit') this.hooks.automaticEnded(job, error as Error, cancelled)
    } finally {
      this.finish(running)
    }
  }

  private begin(label: string, automatic: boolean): Running {
    let end!: () => void
    const ended = new Promise<void>(resolve => { end = resolve })
    const running: Running = { id: randomUUID(), label, automatic, controller: new AbortController(), ended, end }
    this.running = running
    this.hooks.progress({ id: running.id, label, fraction: 0 })
    return running
  }

  private options(running: Running): JobOptions {
    return { signal: running.controller.signal,
      onProgress: fraction => this.hooks.progress({ id: running.id, label: running.label, fraction }) }
  }

  private finish(running: Running): void {
    this.running = null
    running.end() // First: a recording waiting in yieldToRecording must not depend on the hooks.
    this.hooks.progress({ id: running.id, label: running.label, fraction: 1, done: true })
    this.hooks.settled()
    this.startPending()
  }
}
