#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { officeCliBuildScript, officeCliRoot } from "./shared.js";

if (!existsSync(officeCliRoot)) {
  console.error(`Vendored OfficeCli source not found at ${officeCliRoot}`);
  process.exit(1);
}

if (!existsSync(officeCliBuildScript)) {
  console.error(`Vendored OfficeCli build script not found at ${officeCliBuildScript}`);
  process.exit(1);
}

const result = spawnSync("bash", [officeCliBuildScript, "release"], {
  cwd: officeCliRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
