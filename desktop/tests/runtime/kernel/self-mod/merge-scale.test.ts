/**
 * Scale guard for the three-way text merge: the previous LCS
 * implementation allocated a full (n+1)x(m+1) table — a 16k-line file
 * meant ~256M cells and an OOM. The Myers-based diff must merge large
 * files quickly and correctly.
 */
import { describe, expect, it } from "vitest";
import { mergeTextContent } from "../../../../../runtime/kernel/self-mod/stella-source-control.js";

const bigFile = (lines: number): string[] =>
  Array.from({ length: lines }, (_, index) => `const line${index} = ${index};\n`);

describe("mergeTextContent at scale", () => {
  it("cleanly merges non-overlapping edits in a 16k-line file", () => {
    const base = bigFile(16_000);
    const local = [...base];
    local[10] = "const line10 = 'local edit';\n";
    const incoming = [...base];
    incoming[15_990] = "const line15990 = 'incoming edit';\n";
    incoming.push("const appended = true;\n");

    const result = mergeTextContent(
      base.join(""),
      local.join(""),
      incoming.join(""),
    );

    expect(result.status).toBe("clean");
    if (result.status === "clean") {
      expect(result.content).toContain("'local edit'");
      expect(result.content).toContain("'incoming edit'");
      expect(result.content).toContain("const appended = true;");
    }
  });

  it("still detects genuine conflicts in a large file", () => {
    const base = bigFile(12_000);
    const local = [...base];
    local[6_000] = "const line6000 = 'local version';\n";
    const incoming = [...base];
    incoming[6_000] = "const line6000 = 'incoming version';\n";

    const result = mergeTextContent(
      base.join(""),
      local.join(""),
      incoming.join(""),
    );

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.local).toContain("'local version'");
      expect(result.incoming).toContain("'incoming version'");
    }
  });
});
