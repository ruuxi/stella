import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Stella Browser daemon launch", () => {
  it("starts the native service directly without a resident Node launcher", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../electron/services/stella-browser-bridge-service.ts",
      ),
      "utf8",
    );
    const spawnDaemon = source.slice(
      source.indexOf("  private spawnDaemon()"),
      source.indexOf("  private async waitForDaemonReady()"),
    );

    expect(spawnDaemon).toContain(
      "resolveStellaBrowserBinaryPath(stellaBrowserRoot)",
    );
    expect(spawnDaemon).toContain("const daemon = spawn(\n      binPath,");
    expect(spawnDaemon).not.toContain('path.join(stellaBrowserRoot, "bin"');
    expect(spawnDaemon).not.toContain("process.execPath");
    expect(spawnDaemon).not.toContain("ELECTRON_RUN_AS_NODE");
  });
});
