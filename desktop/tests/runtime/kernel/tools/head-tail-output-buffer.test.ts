import { describe, expect, it } from "vitest";

import {
  HeadTailOutputBuffer,
  RAW_SHELL_OUTPUT_MAX_BYTES,
} from "../../../../../runtime/kernel/tools/head-tail-output-buffer.js";

describe("HeadTailOutputBuffer", () => {
  it("retains equal head and tail regions under the one MiB raw cap", () => {
    const buffer = new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES);
    const head = "H".repeat(RAW_SHELL_OUTPUT_MAX_BYTES / 2);
    const middle = "M".repeat(128);
    const tail = "T".repeat(RAW_SHELL_OUTPUT_MAX_BYTES / 2);

    buffer.pushText(`${head}${middle}${tail}`);
    const snapshot = buffer.snapshot();

    expect(snapshot.retainedBytes).toBe(RAW_SHELL_OUTPUT_MAX_BYTES);
    expect(snapshot.omittedBytes).toBe(Buffer.byteLength(middle));
    expect(snapshot.totalBytes).toBe(
      RAW_SHELL_OUTPUT_MAX_BYTES + Buffer.byteLength(middle),
    );
    expect(snapshot.text.startsWith("H")).toBe(true);
    expect(snapshot.text.endsWith("T")).toBe(true);
    expect(snapshot.text).toContain("128 bytes omitted");
    expect(snapshot.text).not.toContain("M".repeat(128));
  });

  it("drains unread output without changing a separate full-session buffer", () => {
    const full = new HeadTailOutputBuffer(16);
    const unread = new HeadTailOutputBuffer(16);
    full.pushText("first");
    unread.pushText("first");

    expect(unread.drain().text).toBe("first");
    full.pushText("second");
    unread.pushText("second");

    expect(full.snapshot().text).toBe("firstsecond");
    expect(unread.snapshot().text).toBe("second");
  });
});
