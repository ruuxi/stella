/** Audio encoding utilities for speech-to-text WebSocket protocol. */

const TARGET_WAV_SAMPLE_RATE = 16_000;
const PACKET_DURATION_SECONDS = 1;
const SAMPLES_PER_PACKET = TARGET_WAV_SAMPLE_RATE * PACKET_DURATION_SECONDS;

export { TARGET_WAV_SAMPLE_RATE, PACKET_DURATION_SECONDS };

export type PreparedWisprAudio = {
  packetDurationSeconds: number;
  packets: string[];
  volumes: number[];
};

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

export const calculatePacketVolume = (packetSamples: Float32Array): number => {
  if (packetSamples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < packetSamples.length; i += 1) {
    const sample = packetSamples[i]!;
    sum += sample * sample;
  }
  return Math.sqrt(sum / packetSamples.length);
};

export const encodeInt16PacketToBase64 = (packet: Int16Array): string => {
  return arrayBufferToBase64(packet.buffer.slice(
    packet.byteOffset,
    packet.byteOffset + packet.byteLength,
  ));
};

export const packetizeAudioSamples = (samples: Float32Array): PreparedWisprAudio => {
  const packetCount = Math.max(1, Math.ceil(samples.length / SAMPLES_PER_PACKET));
  const packets: string[] = [];
  const volumes: number[] = [];

  for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
    const start = packetIndex * SAMPLES_PER_PACKET;
    const end = Math.min(start + SAMPLES_PER_PACKET, samples.length);

    const packetFloats = new Float32Array(SAMPLES_PER_PACKET);
    if (end > start) {
      packetFloats.set(samples.subarray(start, end));
    }

    const packetPcm = floatToInt16Pcm(packetFloats);
    packets.push(encodeInt16PacketToBase64(packetPcm));
    volumes.push(calculatePacketVolume(packetFloats));
  }

  return {
    packetDurationSeconds: PACKET_DURATION_SECONDS,
    packets,
    volumes,
  };
};

export const prepareAudioForWispr = async (audioBlob: Blob): Promise<PreparedWisprAudio> => {
  let audioContext: AudioContext | null = null;
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = mixAudioBufferToMono(decoded);
    const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_WAV_SAMPLE_RATE);
    return packetizeAudioSamples(resampled);
  } catch {
    return {
      packetDurationSeconds: PACKET_DURATION_SECONDS,
      packets: [await blobToBase64(audioBlob)],
      volumes: [0],
    };
  } finally {
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // Ignore close errors; we already have encoded packets or fallback packets.
      }
    }
  }
};
