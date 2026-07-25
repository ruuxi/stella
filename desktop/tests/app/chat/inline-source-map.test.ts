import { afterEach, describe, expect, it, vi } from "vitest";
import {
  originalPositionFor,
  resetInlineSourceMapCache,
} from "@/app/chat/inline-source-map";

/**
 * These guard the hand-rolled VLQ decoder behind select-area's source
 * resolution. A regression here is silent and nasty: the picker still returns
 * a file and a line, the line is just wrong, which points the agent at
 * unrelated code. The fixtures below are real `mappings` strings, so the
 * expected line/column numbers are ground truth rather than round-trips of our
 * own encoder.
 */

const MODULE_URL = "http://127.0.0.1:5173/src/app/chat/Widget.tsx";

const encodeMap = (map: Record<string, unknown>): string => {
  const json = JSON.stringify(map);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return `//# sourceMappingURL=data:application/json;base64,${base64}`;
};

const mockModule = (body: string) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  resetInlineSourceMapCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("originalPositionFor", () => {
  it("maps a generated position back to its original line and column", async () => {
    // "AAAA" -> col 0, source 0, line 0, col 0.
    // ";AACA" -> next generated line, source line +1.
    // ";;AAEA" -> blank generated line, then source line +2.
    mockModule(
      `code\n${encodeMap({
        version: 3,
        sources: ["Widget.tsx"],
        mappings: "AAAA;AACA;;AAEA",
      })}`,
    );

    await expect(originalPositionFor(MODULE_URL, 1, 1)).resolves.toEqual({
      source: MODULE_URL,
      line: 1,
      column: 1,
    });
    await expect(originalPositionFor(MODULE_URL, 2, 1)).resolves.toMatchObject({
      line: 2,
    });
    await expect(originalPositionFor(MODULE_URL, 4, 1)).resolves.toMatchObject({
      line: 4,
    });
  });

  it("picks the last segment at or before the requested column", async () => {
    // Three segments on generated line 1 at columns 0, 10, 20, mapping to
    // original lines 1, 5 and 9 respectively.
    mockModule(
      `code\n${encodeMap({
        version: 3,
        sources: ["Widget.tsx"],
        mappings: "AAAA,UAIA,UAIA",
      })}`,
    );

    await expect(originalPositionFor(MODULE_URL, 1, 5)).resolves.toMatchObject({
      line: 1,
    });
    await expect(originalPositionFor(MODULE_URL, 1, 15)).resolves.toMatchObject({
      line: 5,
    });
    await expect(originalPositionFor(MODULE_URL, 1, 100)).resolves.toMatchObject(
      { line: 9 },
    );
  });

  it("resolves bare source names against the module URL", async () => {
    // Vite emits `sources: ["Widget.tsx"]`; without resolution the payload
    // would report a basename with no directory.
    mockModule(
      `code\n${encodeMap({
        version: 3,
        sources: ["Widget.tsx"],
        mappings: "AAAA",
      })}`,
    );

    const position = await originalPositionFor(MODULE_URL, 1, 1);
    expect(position?.source).toBe(
      "http://127.0.0.1:5173/src/app/chat/Widget.tsx",
    );
  });

  it("fetches each module once and serves later lookups from cache", async () => {
    const fetchMock = mockModule(
      `code\n${encodeMap({
        version: 3,
        sources: ["Widget.tsx"],
        mappings: "AAAA;AACA",
      })}`,
    );

    await originalPositionFor(MODULE_URL, 1, 1);
    await originalPositionFor(MODULE_URL, 2, 1);
    await originalPositionFor(MODULE_URL, 2, 4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null for a module with no inline map rather than guessing", async () => {
    mockModule("just some code with no sourceMappingURL comment");

    await expect(originalPositionFor(MODULE_URL, 1, 1)).resolves.toBeNull();
  });

  it("returns null when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(originalPositionFor(MODULE_URL, 1, 1)).resolves.toBeNull();
  });

  it("skips one-field segments that have no original counterpart", async () => {
    // "AAAA,I" -> a mapped segment then a generated-only segment at column 4.
    // The generated-only segment must not shadow the mapped one.
    mockModule(
      `code\n${encodeMap({
        version: 3,
        sources: ["Widget.tsx"],
        mappings: "AAAA,I",
      })}`,
    );

    await expect(originalPositionFor(MODULE_URL, 1, 8)).resolves.toMatchObject({
      line: 1,
      column: 1,
    });
  });
});
