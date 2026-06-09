import { spawn, spawnSync } from "child_process";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const chmodBestEffort = async (targetPath: string, mode: number) => {
  try {
    await fsPromises.chmod(targetPath, mode);
  } catch {
    // Ignore platforms and filesystems that do not support POSIX modes.
  }
};

const chmodBestEffortSync = (targetPath: string, mode: number) => {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Ignore platforms and filesystems that do not support POSIX modes.
  }
};

// The (OI)(CI) flags make the grant inheritable by files and subdirectories
// created inside, so one icacls per directory covers every subsequent private
// file write — no per-file spawn. Hardened paths are memoized per process;
// every CreateProcess on Windows is Defender-scanned, so repeat
// ensurePrivateDir calls must not re-spawn.
const hardenedWindowsDirs = new Set<string>();

const windowsDirAclArgs = (dirPath: string): string[] | null => {
  if (process.platform !== "win32") {
    return null;
  }
  const username = process.env.USERNAME;
  if (!username) {
    return null;
  }
  const resolved = path.resolve(dirPath);
  if (hardenedWindowsDirs.has(resolved)) {
    return null;
  }
  hardenedWindowsDirs.add(resolved);
  return [resolved, "/grant", `${username}:(OI)(CI)F`];
};

const tightenWindowsDirAcl = async (dirPath: string) => {
  const args = windowsDirAclArgs(dirPath);
  if (!args) {
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn("icacls", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
};

const tightenWindowsDirAclSync = (dirPath: string) => {
  const args = windowsDirAclArgs(dirPath);
  if (!args) {
    return;
  }

  try {
    spawnSync("icacls", args, {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Ignore ACL hardening failures.
  }
};

export const ensurePrivateDir = async (dirPath: string) => {
  await fsPromises.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodBestEffort(dirPath, PRIVATE_DIR_MODE);
  await tightenWindowsDirAcl(dirPath);
};

export const ensurePrivateDirSync = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffortSync(dirPath, PRIVATE_DIR_MODE);
  tightenWindowsDirAclSync(dirPath);
};

export const writePrivateFile = async (
  filePath: string,
  content: string,
) => {
  await ensurePrivateDir(path.dirname(filePath));
  await fsPromises.writeFile(filePath, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  await chmodBestEffort(filePath, PRIVATE_FILE_MODE);
};

export const writePrivateFileSync = (
  filePath: string,
  content: string,
) => {
  ensurePrivateDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodBestEffortSync(filePath, PRIVATE_FILE_MODE);
};
