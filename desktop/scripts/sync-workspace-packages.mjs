import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");

const WORKSPACE_PACKAGES = [
  "stella-ai",
  "stella-agent-core",
  "stella-runtime",
];

for (const packageName of WORKSPACE_PACKAGES) {
  const sourceRoot = path.join(frontendRoot, "packages", packageName);
  const sourceDist = path.join(sourceRoot, "dist");
  const sourcePackageJson = path.join(sourceRoot, "package.json");
  const targetRoot = path.join(frontendRoot, "node_modules", "@stella", packageName);
  const targetDist = path.join(targetRoot, "dist");
  const targetPackageJson = path.join(targetRoot, "package.json");

  if (!existsSync(sourceDist)) {
    throw new Error(`Missing built dist for ${packageName}: ${sourceDist}`);
  }

  if (!existsSync(targetRoot)) {
    continue;
  }

  mkdirSync(targetRoot, { recursive: true });
  rmSync(targetDist, { recursive: true, force: true });
  cpSync(sourceDist, targetDist, { recursive: true });
  copyFileSync(sourcePackageJson, targetPackageJson);

  console.log(`[sync-workspace-packages] Synced @stella/${packageName}`);
}
