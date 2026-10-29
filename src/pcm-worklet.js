// Interleaved PCM; the renderer acknowledges writes and bounds its queue. Each input is one
// audio track; a message holds one block of FRAMES interleaved frames per track, in input order.
const FRAMES = 2048
class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.channels = options.processorOptions.channels
    this.tracks = options.processorOptions.tracks || 1
    this.block = FRAMES * this.channels
    this.buffer = new Float32Array(this.block * this.tracks)
    this.frame = 0
    this.enabled = false
    this.port.onmessage = event => {
      this.enabled = event.data === 'start'
      this.frame = 0
    }
  }
  process(inputs) {
    // Input 0 always carries the silence source, so its length is the render quantum.
    const length = inputs[0]?.[0]?.length || 0
    if (!this.enabled || !length) return true
    for (let i = 0; i < length; i++) {
      for (let track = 0; track < this.tracks; track++) {
        const input = inputs[track]
        const base = track * this.block + this.frame * this.channels
        for (let channel = 0; channel < this.channels; channel++) {
          // A track without connected channels (a source that ended) records silence.
          this.buffer[base + channel] = input?.length ? input[Math.min(channel, input.length - 1)][i] : 0
        }
      }
      if (++this.frame === FRAMES) {
        this.port.postMessage({ data: this.buffer.buffer,
          audioTime: (currentFrame + i + 1 - FRAMES) / sampleRate }, [this.buffer.buffer])
        this.buffer = new Float32Array(this.block * this.tracks)
        this.frame = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-recorder', PCMRecorder)
