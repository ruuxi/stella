import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const workerEntry = path.join(
  repoRoot,
  "desktop",
  "dist-electron",
  "runtime",
  "worker",
  "entry.js",
);

if (process.env.STELLA_SKIP_POSTINSTALL_DIST_ELECTRON === "1") {
  process.exit(0);
}

const shouldBuild =
  process.env.STELLA_BUILD_DIST_ELECTRON_ON_INSTALL === "1" ||
  existsSync(workerEntry);

if (!shouldBuild) {
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [path.join(scriptDir, "dev-electron-build.mjs"), "--once"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      STELLA_SKIP_POSTINSTALL_DIST_ELECTRON: "1",
    },
  },
);

if (result.error) {
  console.error(
    `[postinstall-dist-electron] Failed to rebuild dist-electron: ${result.error.message}`,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
