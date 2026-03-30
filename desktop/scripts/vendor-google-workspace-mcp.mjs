/**
 * Vendors a pinned release of gemini-cli-extensions/workspace, builds workspace-server,
 * and copies dist/ into resources/google-workspace-mcp/workspace-server/dist/
 *
 * Requires: git, npm, network.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, "..");
const OUT_BASE = path.join(DESKTOP_ROOT, "resources", "google-workspace-mcp");
const OUT_DIST = path.join(OUT_BASE, "workspace-server", "dist");

const TAG = "v0.0.7";
const REPO = "https://github.com/gemini-cli-extensions/workspace.git";

const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
};

const main = () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gw-mcp-"));
  const cloneDir = path.join(tmp, "workspace");
  try {
    console.log(`[vendor-google-workspace-mcp] Cloning ${REPO} @ ${TAG}...`);
    run("git", ["clone", "--depth", "1", "--branch", TAG, REPO, cloneDir], tmp);

    const serverDir = path.join(cloneDir, "workspace-server");
    const rootPkg = JSON.parse(
      readFileSync(path.join(cloneDir, "package.json"), "utf-8"),
    );
    console.log(`[vendor-google-workspace-mcp] Installing workspace (v${rootPkg.version})...`);
    run("npm", ["install", "--legacy-peer-deps"], cloneDir);

    console.log("[vendor-google-workspace-mcp] Building workspace-server...");
    run("npm", ["run", "build", "-w", "workspace-server"], cloneDir);

    const builtIndex = path.join(serverDir, "dist", "index.js");
    if (!existsSync(builtIndex)) {
      throw new Error(`Expected build output missing: ${builtIndex}`);
    }

    rmSync(OUT_DIST, { recursive: true, force: true });
    mkdirSync(OUT_DIST, { recursive: true });
    cpSync(path.join(serverDir, "dist"), OUT_DIST, { recursive: true });

    // The bundled server walks up from __dirname looking for gemini-extension.json
    // to locate its project root. Place it at the google-workspace-mcp/ level so the
    // traversal from workspace-server/dist/ finds it.
    const extensionJson = path.join(cloneDir, "gemini-extension.json");
    if (existsSync(extensionJson)) {
      cpSync(extensionJson, path.join(OUT_BASE, "gemini-extension.json"));
    }

    console.log(`[vendor-google-workspace-mcp] Done. Copied to ${OUT_DIST}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

try {
  main();
} catch (error) {
  console.error("[vendor-google-workspace-mcp] Failed:", error);
  process.exit(1);
}
