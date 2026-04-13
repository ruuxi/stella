#!/usr/bin/env node

/**
 * Copies the compiled Rust binary to bin/ with platform-specific naming
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const sourceExt = platform() === 'win32' ? '.exe' : '';
const sourcePath = join(projectRoot, `cli/target/release/stella-browser${sourceExt}`);
const binDir = join(projectRoot, 'bin');

// Determine platform suffix
const platformKey = `${platform()}-${arch()}`;
const ext = platform() === 'win32' ? '.exe' : '';
const targetName = `stella-browser-${platformKey}${ext}`;
const targetPath = join(binDir, targetName);

if (!existsSync(sourcePath)) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error('Run "cargo build --release --manifest-path cli/Cargo.toml" first');
  process.exit(1);
}

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

const tempPath = join(binDir, `.${targetName}.${process.pid}.tmp`);

try {
  // Replace via a fresh temp file so repeated builds do not reuse the old inode.
  // In this repo, Cursor's shell path could get stuck launching the previous inode
  // even when the file contents had been overwritten in place.
  copyFileSync(sourcePath, tempPath);

  if (platform() !== 'win32') {
    chmodSync(tempPath, 0o755);
  }

  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (platform() === 'win32' && existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
      renameSync(tempPath, targetPath);
    } else {
      throw error;
    }
  }
} catch (error) {
  if (existsSync(tempPath)) {
    rmSync(tempPath, { force: true });
  }
  console.error(`Error: Failed to copy native binary to ${targetPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`✓ Copied native binary to ${targetPath}`);
