import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGoogleWorkspaceTools } from "../../../../../runtime/kernel/google-workspace/load-google-workspace-tools.js";
import { saveCredentials } from "../../../../../runtime/kernel/google-workspace/stella-credential-storage.js";

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

  it("disconnect tears down runtime state without deleting stored credentials", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-gw-"));
    const credentialsPath = path.join(
      dir,
      "state",
      "google-workspace",
      "oauth-credentials.json",
    );
    try {
      await loadGoogleWorkspaceTools({
        stellaRoot: dir,
      }).then(async ({ disconnect }) => {
        await saveCredentials({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: Date.now() + 60_000,
        });
        expect(existsSync(credentialsPath)).toBe(true);
        await disconnect();
        expect(existsSync(credentialsPath)).toBe(true);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
