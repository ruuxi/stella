#!/usr/bin/env node

import { spawn } from "child_process";
import { accessSync, chmodSync, constants, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { arch, platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case "darwin":
      osKey = "darwin";
      break;
    case "linux":
      osKey = "linux";
      break;
    case "win32":
      osKey = "win32";
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case "x64":
    case "x86_64":
      archKey = "x64";
      break;
    case "arm64":
    case "aarch64":
      archKey = "arm64";
      break;
    default:
      return null;
  }

  const ext = os === "win32" ? ".exe" : "";
  return `stella-office-${osKey}-${archKey}${ext}`;
}

function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
  }

  const binaryPath = join(__dirname, binaryName);

  if (!existsSync(binaryPath)) {
    console.error(`Error: No stella-office binary found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    process.exit(1);
  }

  if (platform() !== "win32") {
    try {
      accessSync(binaryPath, constants.X_OK);
    } catch {
      try {
        chmodSync(binaryPath, 0o755);
      } catch (chmodErr) {
        console.error(`Error: Cannot make binary executable: ${chmodErr.message}`);
        process.exit(1);
      }
    }
  }

  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      OFFICECLI_SKIP_UPDATE: "1",
    },
  });

  child.on("error", (err) => {
    console.error(`Error executing stella-office binary: ${err.message}`);
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

main();
