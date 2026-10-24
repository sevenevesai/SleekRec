// Interleaved PCM; the renderer acknowledges writes and bounds its queue.
class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.channels = options.processorOptions.channels
    this.buffer = new Float32Array(2048 * this.channels)
    this.offset = 0
    this.enabled = false
    this.port.onmessage = event => {
      this.enabled = event.data === 'start'
      this.offset = 0
    }
  }
  process(inputs) {
    const input = inputs[0]
    if (!this.enabled || !input?.length) return true
    for (let frame = 0; frame < input[0].length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) {
        this.buffer[this.offset++] = input[Math.min(channel, input.length - 1)][frame]
      }
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ data: this.buffer.buffer,
          audioTime: (currentFrame + frame + 1 - 2048) / sampleRate }, [this.buffer.buffer])
        this.buffer = new Float32Array(2048 * this.channels)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-recorder', PCMRecorder)
