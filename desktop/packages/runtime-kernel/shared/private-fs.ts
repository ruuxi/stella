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

const tightenWindowsAcl = async (targetPath: string) => {
  if (process.platform !== "win32") {
    return;
  }
  const username = process.env.USERNAME;
  if (!username) {
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(
      "icacls",
      [
        targetPath,
        "/grant",
        `${username}:F`,
      ],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
};

const tightenWindowsAclSync = (targetPath: string) => {
  if (process.platform !== "win32") {
    return;
  }
  const username = process.env.USERNAME;
  if (!username) {
    return;
  }

  try {
    const child = spawnSync("icacls", [
      targetPath,
      "/grant",
      `${username}:F`,
    ], {
      stdio: "ignore",
      windowsHide: true,
    });
    void child;
  } catch {
    // Ignore ACL hardening failures.
  }
};

export const ensurePrivateDir = async (dirPath: string) => {
  await fsPromises.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodBestEffort(dirPath, PRIVATE_DIR_MODE);
  await tightenWindowsAcl(dirPath);
};

export const ensurePrivateDirSync = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffortSync(dirPath, PRIVATE_DIR_MODE);
  tightenWindowsAclSync(dirPath);
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
  await tightenWindowsAcl(filePath);
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
  tightenWindowsAclSync(filePath);
};
