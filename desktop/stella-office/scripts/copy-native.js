#!/usr/bin/env node

import { copyFileSync, existsSync } from "node:fs";
import {
  finalizeBundledBinary,
  getBundledBinaryPath,
  getOfficeCliReleaseBinaryPath,
} from "./shared.js";

const sourcePath = getOfficeCliReleaseBinaryPath();
const targetPath = getBundledBinaryPath();

if (!existsSync(sourcePath)) {
  console.error(`Error: OfficeCli binary not found at ${sourcePath}`);
  console.error(
    "Build the vendored OfficeCli source first (for example: `npm run build:native` in `desktop/stella-office`).",
  );
  process.exit(1);
}

copyFileSync(sourcePath, targetPath);
finalizeBundledBinary(targetPath);

console.log(`Copied OfficeCli binary to ${targetPath}`);
