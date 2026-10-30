import workletUrl from './pcm-worklet.js?url'
import { AppSettings, audioTrackTitles, qualityPresets } from './recording'

export class CaptureAudio {
  micGain: GainNode | null = null
  context: AudioContext | null = null
  output: MediaStream | null = null
  private streams: MediaStream[] = []
  private mix?: GainNode
  private system?: AudioNode
  private channels = 2
  private tracks = 1
  private worklet?: AudioWorkletNode
  private silence?: ConstantSourceNode
  private sending = false
  private pending = Promise.resolve()
  private queuedBytes = 0
  private failure?: Error

  async open(settings: AppSettings, desktop?: MediaStream, sourceId?: string): Promise<void> {
    const preset = qualityPresets[settings.qualityPreset]
    this.channels = preset.audioChannels
    // Separate tracks are native-only: MediaRecorder writes a single audio track.
    this.tracks = desktop ? 1 : Math.max(1, audioTrackTitles(settings).length)
    if (!settings.systemAudio && !settings.micEnabled) return
    try {
      const ctx = new AudioContext({ sampleRate: preset.audioSampleRate })
      this.context = ctx
      this.mix = ctx.createGain()
      const destination = ctx.createMediaStreamDestination()
      destination.channelCount = preset.audioChannels
      destination.channelCountMode = 'explicit'
      this.mix.connect(destination)
      if (settings.systemAudio) {
        let system = desktop
        if (!system) {
          // Electron 29-44 kill the renderer on audio-only loopback (electron#42765). Discard
          // this 16px/1fps companion; the native recorder captures the actual video.
          system = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } } as MediaTrackConstraints,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
              maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } } as MediaTrackConstraints,
          })
          this.streams.push(system)
        }
        if (!system.getAudioTracks().length) throw new Error('System audio capture is unavailable. Turn off System audio to record video only.')
        this.system = ctx.createMediaStreamSource(new MediaStream(system.getAudioTracks()))
        this.system.connect(this.mix)
      }
      if (settings.micEnabled) {
        const raw = settings.micRawInput
        const mic = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw,
          sampleRate: preset.audioSampleRate, channelCount: preset.audioChannels,
          ...(settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : {}),
        } }).catch((error: DOMException) => {
          // An unplugged device raises OverconstrainedError, whose message is empty.
          throw new Error(`The microphone is unavailable (${error.name}). Choose another in Settings, or turn Microphone off.`)
        })
        this.streams.push(mic)
        this.micGain = ctx.createGain()
        this.micGain.gain.value = settings.micVolume
        ctx.createMediaStreamSource(mic).connect(this.micGain).connect(this.mix)
      }
      this.output = destination.stream
      await ctx.resume()
    } catch (error) {
      this.close()
      throw error
    }
  }

  async startPCM(id: string, onError: (error: Error) => void): Promise<void> {
    if (!this.context || !this.mix) return
    const ctx = this.context
    if (!this.worklet) {
      await ctx.audioWorklet.addModule(workletUrl)
      this.worklet = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: this.tracks,
        channelCount: this.channels, channelCountMode: 'explicit',
        processorOptions: { channels: this.channels, tracks: this.tracks } })
      // Native PCM uses one audio graph/clock. A MediaStream round trip can
      // independently buffer/pull the graph and accumulate latency over time.
      this.mix.disconnect()
      this.mix.connect(this.worklet, 0, 0)
      // Separate tracks tap the same nodes the mix sums, after mic gain, so mute and volume
      // apply to both and every track shares the graph's clock (audioTrackTitles order).
      if (this.tracks === 3) {
        this.system?.connect(this.worklet, 0, 1)
        this.micGain?.connect(this.worklet, 0, 2)
      }
      this.output?.getTracks().forEach(track => track.stop())
      this.output = null
      this.silence = ctx.createConstantSource()
      this.silence.offset.value = 0
      for (let input = 0; input < this.tracks; input++) this.silence.connect(this.worklet, 0, input)
      this.silence.start()
      const mute = ctx.createGain()
      mute.gain.value = 0
      this.worklet.connect(mute).connect(ctx.destination)
      this.worklet.port.onmessage = event => {
        if (!this.sending || this.failure) return
        const { data: buffer, audioTime } = event.data as { data: ArrayBuffer; audioTime: number }
        const bytes = buffer.byteLength
        const stamp = ctx.getOutputTimestamp()
        const capturedAt = performance.timeOrigin + (stamp.contextTime
          ? stamp.performanceTime! + (audioTime - stamp.contextTime) * 1000
          : performance.now() + (audioTime - ctx.currentTime) * 1000)
        this.queuedBytes += bytes
        if (this.queuedBytes > 2_000_000 * this.tracks) {
          this.failure = new Error('Audio cannot keep up. Recording has stopped to preserve synchronization.')
          onError(this.failure)
          return
        }
        const tracks = this.tracks
        this.pending = this.pending.then(() => window.electronAPI.nativeAudio(id, { data: buffer, capturedAt, tracks }))
          .catch(error => {
            if (!this.failure && this.sending) {
              this.failure = error instanceof Error ? error : new Error(String(error))
              onError(this.failure)
            }
          }).finally(() => { this.queuedBytes -= bytes })
      }
    }
    this.sending = true
    this.worklet.port.postMessage('start')
  }

  async pausePCM(): Promise<void> {
    this.sending = false
    this.worklet?.port.postMessage('pause')
    await this.pending
  }

  close(): void {
    this.sending = false
    this.worklet?.port.close()
    this.worklet?.disconnect()
    this.silence?.stop()
    this.output?.getTracks().forEach(track => track.stop())
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()))
    this.streams = []
    void this.context?.close()
    this.context = null
    this.micGain = null
    this.output = null
  }
}
