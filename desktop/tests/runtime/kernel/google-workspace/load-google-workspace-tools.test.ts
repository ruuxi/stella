import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGoogleWorkspaceTools } from "../../../../runtime/kernel/google-workspace/load-google-workspace-tools.js";

describe("loadGoogleWorkspaceTools", () => {
  it("registers provider-safe allowlisted tools and time helpers work without Google auth", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-gw-"));
    try {
      const { tools, callTool, disconnect, hasStoredCredentials } =
        await loadGoogleWorkspaceTools({
          stellaRoot: dir,
        });
      expect(tools.length).toBeGreaterThan(10);
      expect(callTool).toBeTypeOf("function");
      expect(hasStoredCredentials).toBe(false);
      expect(tools.every((tool) => !tool.name.includes("."))).toBe(true);
      expect(tools.some((tool) => tool.name === "time_getTimeZone")).toBe(true);

      const tz = await callTool!("time.getTimeZone", {});
      expect("result" in tz).toBe(true);
      expect(String((tz as { result?: unknown }).result)).toContain("timeZone");

      await disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
