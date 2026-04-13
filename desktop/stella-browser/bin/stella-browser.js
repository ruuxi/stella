#!/usr/bin/env node

/**
 * Cross-platform CLI wrapper for stella-browser
 * 
 * This wrapper enables consistent invocation across install modes and platforms.
 */

import { spawn } from 'child_process';
import { existsSync, accessSync, chmodSync, constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function resolveBinaryPath(binaryName) {
  const forcedBinaryPath = process.env.STELLA_BROWSER_BINARY_PATH;
  if (forcedBinaryPath) {
    return forcedBinaryPath;
  }

  const packagedBinaryPath = join(__dirname, binaryName);
  const sourceBinaryName = platform() === 'win32' ? 'stella-browser.exe' : 'stella-browser';
  const debugBinaryPath = join(__dirname, '..', 'cli', 'target', 'debug', sourceBinaryName);
  const cargoManifestPath = join(__dirname, '..', 'cli', 'Cargo.toml');
  const preferPackagedBinary = process.env.STELLA_BROWSER_PREFER_PACKAGED_BINARY === '1';

  // In a local repo checkout, prefer the debug build when available. The release
  // build currently hangs under the captured shell environment used by Stella's
  // task runtime, while the debug binary returns output correctly.
  if (!preferPackagedBinary && existsSync(cargoManifestPath) && existsSync(debugBinaryPath)) {
    return debugBinaryPath;
  }

  return packagedBinaryPath;
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
    console.error('or reinstall the package to trigger the postinstall download.');
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
        console.error(`Error: Cannot make binary executable: ${chmodErr.message}`);
        console.error('Try running: chmod +x ' + binaryPath);
        process.exit(1);
      }
    }
  }

  // Keep stdin interactive, but pipe stdout/stderr through this wrapper so callers
  // like ExecuteTypescript's shell.exec() can capture command output.
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
