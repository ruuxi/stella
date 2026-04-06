#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync } from "node:fs";
import {
  ensureBinDir,
  getBundledBinaryPath,
  getOfficeCliReleaseBinaryPath,
} from "./shared.js";

const sourcePath = getOfficeCliReleaseBinaryPath();
const targetPath = getBundledBinaryPath();

if (!existsSync(sourcePath)) {
  console.error(`Error: OfficeCli binary not found at ${sourcePath}`);
  console.error(
    'Build the vendored OfficeCli source first (for example: `npm run build:native` in `desktop/stella-office`).',
  );
  process.exit(1);
}

ensureBinDir();
copyFileSync(sourcePath, targetPath);

if (process.platform !== "win32") {
  chmodSync(targetPath, 0o755);
}

console.log(`Copied OfficeCli binary to ${targetPath}`);
