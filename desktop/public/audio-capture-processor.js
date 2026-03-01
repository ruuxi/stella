// AudioWorkletProcessor that buffers input samples and posts them to the main thread.
// Buffer size matches the old ScriptProcessorNode (2048 samples) to avoid excessive postMessage calls.
const BUFFER_SIZE = 2048;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(BUFFER_SIZE);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let pos = 0;
    while (pos < input.length) {
      const remaining = BUFFER_SIZE - this._offset;
      const toCopy = Math.min(remaining, input.length - pos);
      this._buffer.set(input.subarray(pos, pos + toCopy), this._offset);
      this._offset += toCopy;
      pos += toCopy;

      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(new Float32Array(this._buffer));
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
