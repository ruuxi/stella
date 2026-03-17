/** Audio encoding utilities for OpenAI Realtime transcription sessions. */

const TARGET_PCM_SAMPLE_RATE = 24_000;

export { TARGET_PCM_SAMPLE_RATE };
export const TARGET_WAV_SAMPLE_RATE = TARGET_PCM_SAMPLE_RATE;

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read audio blob"));
    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(blob);
  });
};

const arrayBufferToBase64 = (buffer: ArrayBufferLike): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

const mixAudioBufferToMono = (audioBuffer: AudioBuffer): Float32Array => {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channelData[i]!;
    }
  }

  for (let i = 0; i < length; i += 1) {
    mono[i] /= channelCount;
  }

  return mono;
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

export const decodeAudioBlobToMonoSamples = async (
  audioBlob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number }> => {
  let audioContext: AudioContext | null = null;
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    return {
      samples: mixAudioBufferToMono(decoded),
      sampleRate: decoded.sampleRate,
    };
  } finally {
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // Ignore close failures; callers already have the decoded result.
      }
    }
  }
};
