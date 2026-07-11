import { afterEach, describe, expect, it } from "vitest";

import {
  currentSelfModLedgerCursor,
  detectSelfModAppliedSinceCursor,
  recordSelfModCommitInLedger,
  resetSelfModLedgerForTests,
} from "../../../../../runtime/kernel/self-mod/applied-ledger.js";
const SELF_MOD_MESSAGE = [
  "Add a confetti button",
  "",
  "Stella-Conversation: conv-1",
].join("\n");

afterEach(() => {
  resetSelfModLedgerForTests();
});

describe("self-mod applied ledger", () => {
  it("surfaces a commit recorded after the captured cursor", () => {
    const cursor = currentSelfModLedgerCursor();
    recordSelfModCommitInLedger({
      commitHash: "abc123",
      files: ["desktop/src/App.tsx"],
      message: SELF_MOD_MESSAGE,
    });

    expect(detectSelfModAppliedSinceCursor(cursor)).toEqual({
      commitHash: "abc123",
      files: ["desktop/src/App.tsx"],
      batchIndex: 0,
    });
  });

  it("does not surface commits recorded before the cursor", () => {
    recordSelfModCommitInLedger({
      commitHash: "old111",
      files: ["a.ts"],
      message: SELF_MOD_MESSAGE,
    });
    const cursor = currentSelfModLedgerCursor();

    expect(detectSelfModAppliedSinceCursor(cursor)).toBeNull();
  });

  it("returns the newest entry when several land during one run", () => {
    const cursor = currentSelfModLedgerCursor();
    recordSelfModCommitInLedger({
      commitHash: "first",
      files: ["a.ts"],
      message: SELF_MOD_MESSAGE,
    });
    recordSelfModCommitInLedger({
      commitHash: "second",
      files: ["b.ts"],
      message: SELF_MOD_MESSAGE,
    });

    expect(detectSelfModAppliedSinceCursor(cursor)?.commitHash).toBe("second");
  });

  it("ignores commits whose message is not a Stella self-mod commit", () => {
    const cursor = currentSelfModLedgerCursor();
    recordSelfModCommitInLedger({
      commitHash: "plain",
      files: ["a.ts"],
      message: "Just a regular commit\n\nno trailers here",
    });

    expect(detectSelfModAppliedSinceCursor(cursor)).toBeNull();
  });

  it("detects nothing for a missing or malformed cursor", () => {
    recordSelfModCommitInLedger({
      commitHash: "abc123",
      files: ["a.ts"],
      message: SELF_MOD_MESSAGE,
    });

    expect(detectSelfModAppliedSinceCursor(null)).toBeNull();
    expect(detectSelfModAppliedSinceCursor(undefined)).toBeNull();
    expect(detectSelfModAppliedSinceCursor("not-a-number")).toBeNull();
  });
});
