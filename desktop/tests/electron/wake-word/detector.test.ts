import { describe, expect, it } from "vitest";
import {
  float16BitsToNumber,
  readScalarTensorValue,
} from "../../../electron/wake-word/detector.js";

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
});
