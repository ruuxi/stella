#!/usr/bin/env node

/**
 * Cross-platform launcher for the Stella browser service.
 *
 * This wrapper enables consistent invocation across install modes and platforms.
 */

import { spawn } from 'child_process';
import {
  existsSync,
  accessSync,
  chmodSync,
  constants,
  renameSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';

const __dirname = import.meta.dirname;

// Map Node.js platform/arch to binary naming convention
function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case 'darwin':
      osKey = 'darwin';
      break;
    case 'linux':
      osKey = 'linux';
      break;
    case 'win32':
      osKey = 'win32';
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case 'x64':
    case 'x86_64':
      archKey = 'x64';
      break;
    case 'arm64':
    case 'aarch64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  const ext = os === 'win32' ? '.exe' : '';
  return `stella-browser-${osKey}-${archKey}${ext}`;
}

function getPlatformKey() {
  const os = platform();
  const cpuArch = arch();
  const osKey = os === 'win32' ? 'win' : os;
  const archKey =
    cpuArch === 'x86_64' ? 'x64' : cpuArch === 'aarch64' ? 'arm64' : cpuArch;
  if (
    !['darwin', 'linux', 'win'].includes(osKey) ||
    !['x64', 'arm64'].includes(archKey)
  ) {
    return null;
  }
  return `${osKey}-${archKey}`;
}

function promoteStagedBinary(binaryPath) {
  const stagedPath = `${binaryPath}.update`;
  if (!existsSync(stagedPath)) return;
  const previousPath = `${binaryPath}.previous`;
  try {
    rmSync(previousPath, { force: true });
    if (existsSync(binaryPath)) renameSync(binaryPath, previousPath);
    renameSync(stagedPath, binaryPath);
    rmSync(previousPath, { force: true });
  } catch (error) {
    if (!existsSync(binaryPath) && existsSync(previousPath)) {
      try {
        renameSync(previousPath, binaryPath);
      } catch {
        // Keep the original error; startup cannot proceed without a binary.
      }
    }
    console.error(
      `Error: Cannot activate browser service update: ${error.message}`,
    );
    process.exit(1);
  }
}

function resolveBinaryPath(binaryName) {
  const forcedBinaryPath = process.env.STELLA_BROWSER_BINARY_PATH;
  if (forcedBinaryPath) {
    return forcedBinaryPath;
  }

  const platformKey = getPlatformKey();
  const hydratedName =
    platform() === 'win32' ? 'stella-browser.exe' : 'stella-browser';
  const hydratedPath = platformKey
    ? join(__dirname, '..', 'out', platformKey, hydratedName)
    : null;
  if (hydratedPath) {
    promoteStagedBinary(hydratedPath);
    if (existsSync(hydratedPath)) return hydratedPath;
  }

  // Temporary migration fallback for installs made before browser artifacts
  // moved out of the tracked bin/ directory.
  const legacyPath = join(__dirname, binaryName);
  promoteStagedBinary(legacyPath);
  return legacyPath;
}

function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
  }

  const binaryPath = resolveBinaryPath(binaryName);

  if (!existsSync(binaryPath)) {
    console.error(`Error: No binary found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error('Run "npm run build:native" to build for your platform,');
    console.error(
      'or reinstall the package to trigger the postinstall download.',
    );
    process.exit(1);
  }

  // Ensure binary is executable (fixes EACCES on macOS/Linux when postinstall didn't run,
  // e.g., when using bun which blocks lifecycle scripts by default)
  if (platform() !== 'win32') {
    try {
      accessSync(binaryPath, constants.X_OK);
    } catch {
      // Binary exists but isn't executable - fix it
      try {
        chmodSync(binaryPath, 0o755);
      } catch (chmodErr) {
        console.error(
          `Error: Cannot make binary executable: ${chmodErr.message}`,
        );
        console.error('Try running: chmod +x ' + binaryPath);
        process.exit(1);
      }
    }
  }

  // Native-host mode needs stdin; service and diagnostic output stays visible to
  // the parent process for lifecycle monitoring and troubleshooting.
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  child.on('error', (err) => {
    console.error(`Error executing binary: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

main();
