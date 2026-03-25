import { describe, expect, it } from "vitest";
import {
  WAKE_WORD_VAD_GATE_THRESHOLD,
  createWakeWordVadGateState,
  estimateWakeWordVadScore,
  float16BitsToNumber,
  readScalarTensorValue,
} from "../../../electron/wake-word/detector.js";

function createSineChunk(
  level: number,
  frequencyHz: number,
  length = 1280,
  sampleRate = 16000,
): Int16Array {
  const amplitude = Math.round(Math.max(0, Math.min(1, level)) * 32767);
  return Int16Array.from({ length }, (_, index) =>
    Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * amplitude,
    ),
  );
}

describe("wake-word detector scalar decoding", () => {
  it("decodes common float16 values correctly", () => {
    expect(float16BitsToNumber(0x0000)).toBe(0);
    expect(float16BitsToNumber(0x3800)).toBe(0.5);
    expect(float16BitsToNumber(0x3c00)).toBe(1);
  });

  it("reads float16 tensor scalars instead of treating raw bits as integers", () => {
    const tensor = {
      data: new Uint16Array([0x3c00]),
    } as never;

    expect(readScalarTensorValue(tensor, "float16")).toBe(1);
  });

  it("reads float32 tensor scalars as numbers", () => {
    const tensor = {
      data: new Float32Array([0.875]),
    } as never;

    expect(readScalarTensorValue(tensor, "float32")).toBeCloseTo(0.875);
  });

  it("closes the hard VAD gate below the speech threshold", () => {
    expect(createWakeWordVadGateState(0.49)).toEqual({
      threshold: WAKE_WORD_VAD_GATE_THRESHOLD,
      gateOpen: false,
    });
  });

  it("opens the hard VAD gate at or above the speech threshold", () => {
    expect(createWakeWordVadGateState(0.5)).toEqual({
      threshold: WAKE_WORD_VAD_GATE_THRESHOLD,
      gateOpen: true,
    });
    expect(createWakeWordVadGateState(0.82)).toEqual({
      threshold: WAKE_WORD_VAD_GATE_THRESHOLD,
      gateOpen: true,
    });
  });

  it("keeps the heuristic VAD score near zero for silence", () => {
    expect(estimateWakeWordVadScore(new Int16Array(1280))).toBe(0);
  });

  it("raises the heuristic VAD score for voiced audio", () => {
    const score = estimateWakeWordVadScore(createSineChunk(0.08, 220));

    expect(score).toBeGreaterThanOrEqual(WAKE_WORD_VAD_GATE_THRESHOLD);
  });
});
