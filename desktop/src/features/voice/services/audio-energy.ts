export function computeAnalyserEnergy(
  analyser: AnalyserNode | null,
  buffer: Uint8Array | null,
): { energy: number; buffer: Uint8Array | null } {
  if (!analyser) {
    return { energy: 0, buffer };
  }

  const len = analyser.frequencyBinCount;
  let targetBuffer = buffer as Uint8Array<ArrayBuffer> | null;
  if (!targetBuffer || targetBuffer.length < len) {
    targetBuffer = new Uint8Array(len);
  }

  analyser.getByteFrequencyData(targetBuffer);
  let sum = 0;
  for (let i = 0; i < len; i += 1) {
    const value = targetBuffer[i] / 255;
    sum += value * value;
  }

  return {
    energy: Math.sqrt(sum / Math.max(1, len)),
    buffer: targetBuffer,
  };
}
