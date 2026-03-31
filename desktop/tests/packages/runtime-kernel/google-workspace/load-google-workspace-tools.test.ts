import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGoogleWorkspaceTools } from "../../../../packages/runtime-kernel/google-workspace/load-google-workspace-tools.js";

describe("loadGoogleWorkspaceTools", () => {
  it("registers allowlisted tools and time helpers work without Google auth", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-gw-"));
    try {
      const { tools, callTool, disconnect, hasStoredCredentials } =
        await loadGoogleWorkspaceTools({
          stellaHomePath: dir,
        });
      expect(tools.length).toBeGreaterThan(10);
      expect(callTool).toBeTypeOf("function");
      expect(hasStoredCredentials).toBe(false);

      const tz = await callTool!("time.getTimeZone", {});
      expect("result" in tz).toBe(true);
      expect(String((tz as { result?: unknown }).result)).toContain("timeZone");

      await disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
