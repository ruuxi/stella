/**
 * Stella dictation PCM capture worklet.
 *
 * Loaded by `desktop/src/features/dictation/services/inworld-dictation.ts`
 * from the renderer origin so it satisfies the renderer CSP (Blob URLs are
 * blocked by `script-src 'self'`). Mixes input channels to mono and posts
 * the raw Float32 frames back to the main thread, where downsampling, PCM
 * conversion and base64 encoding happen before the chunk is sent over the
 * Inworld STT WebSocket.
 */
class StellaDictationPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelCount = input.length;
    const frameCount = input[0].length;
    if (frameCount === 0) return true;

    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = input[channel];
      for (let i = 0; i < frameCount; i += 1) {
        mono[i] += channelData[i];
      }
    }
    if (channelCount > 1) {
      for (let i = 0; i < frameCount; i += 1) {
        mono[i] /= channelCount;
      }
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("stella-dictation-pcm-capture", StellaDictationPcmProcessor);
