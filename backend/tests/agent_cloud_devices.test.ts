import { describe, test, expect } from "bun:test";
import { assertNdjsonNoError } from "../convex/agent/cloud_devices";

describe("assertNdjsonNoError", () => {
  test("passes for valid non-error NDJSON", () => {
    const raw = '{"type":"result","data":"ok"}\n{"type":"status","data":"done"}';
    expect(() => assertNdjsonNoError(raw, "test")).not.toThrow();
  });

  test("passes for empty string", () => {
    expect(() => assertNdjsonNoError("", "test")).not.toThrow();
  });

  test("passes for non-JSON lines", () => {
    expect(() => assertNdjsonNoError("not json\nalso not json", "test")).not.toThrow();
  });

  test("throws on error type with error field", () => {
    const raw = '{"type":"error","error":"Something went wrong"}';
    expect(() => assertNdjsonNoError(raw, "deploy")).toThrow("deploy failed: Something went wrong");
  });

  test("throws on error type with data field", () => {
    const raw = '{"type":"error","data":"connection refused"}';
    expect(() => assertNdjsonNoError(raw, "exec")).toThrow("exec failed: connection refused");
  });

  test("throws on error type even without error/data fields", () => {
    const raw = '{"type":"error"}';
    expect(() => assertNdjsonNoError(raw, "op")).toThrow("op failed:");
  });

  test("handles mixed lines with error", () => {
    const raw = '{"type":"result","data":"ok"}\n{"type":"error","error":"oops"}';
    expect(() => assertNdjsonNoError(raw, "mixed")).toThrow("mixed failed: oops");
  });

  test("trims whitespace from lines", () => {
    const raw = '  {"type":"result"}  \n  {"type":"error","error":"fail"}  ';
    expect(() => assertNdjsonNoError(raw, "ws")).toThrow("ws failed: fail");
  });

  test("ignores blank lines", () => {
    const raw = '\n\n{"type":"result"}\n\n';
    expect(() => assertNdjsonNoError(raw, "blank")).not.toThrow();
  });
});
