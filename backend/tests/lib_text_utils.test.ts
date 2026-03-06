import { describe, test, expect } from "bun:test";
import { truncateWithSuffix, stringifyBounded } from "@stella/shared";

describe("truncateWithSuffix", () => {
  test("returns short strings unchanged", () => {
    expect(truncateWithSuffix("hi", 10)).toBe("hi");
  });

  test("truncates long strings with default suffix", () => {
    const result = truncateWithSuffix("hello world this is long", 10);
    expect(result).toBe("hello worl...(truncated)");
  });

  test("uses custom suffix", () => {
    const result = truncateWithSuffix("abcdefghij", 5, "…");
    expect(result).toBe("abcde…");
  });

  test("handles exact length", () => {
    expect(truncateWithSuffix("abc", 3)).toBe("abc");
  });
});

describe("stringifyBounded", () => {
  test("truncates string values", () => {
    const result = stringifyBounded("a".repeat(100), 20);
    expect(result.length).toBeLessThanOrEqual(20 + "...(truncated)".length);
  });

  test("stringifies objects", () => {
    const result = stringifyBounded({ key: "value" }, 100);
    expect(result).toBe('{"key":"value"}');
  });

  test("handles null", () => {
    const result = stringifyBounded(null, 100);
    expect(result).toBe("null");
  });
});
