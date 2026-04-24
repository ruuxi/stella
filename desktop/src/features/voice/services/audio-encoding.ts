/** Audio encoding utilities for OpenAI Realtime transcription sessions. */

const TARGET_PCM_SAMPLE_RATE = 24_000;

export { TARGET_PCM_SAMPLE_RATE };

const arrayBufferToBase64 = (buffer: ArrayBufferLike): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

export const resampleLinear = (
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array => {
  if (sourceRate === targetRate) return samples;

  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const resampled = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i += 1) {
    const sourceIndex = i * ratio;
    const sourceFloor = Math.floor(sourceIndex);
    const sourceCeil = Math.min(sourceFloor + 1, samples.length - 1);
    const alpha = sourceIndex - sourceFloor;
    const a = samples[sourceFloor]!;
    const b = samples[sourceCeil]!;
    resampled[i] = a + (b - a) * alpha;
  }

  return resampled;
};

export const floatToInt16Pcm = (samples: Float32Array): Int16Array => {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
};

export const encodeInt16ToBase64 = (pcm: Int16Array): string => {
  return arrayBufferToBase64(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );
};
