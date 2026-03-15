import { statSync } from 'node:fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Get the base directory for socket/pid/state files.
 * Priority: STELLA_BROWSER_SOCKET_DIR > repo-local .stella > XDG_RUNTIME_DIR > home dir fallback > tmpdir
 */
export function getAppDir(): string {
  const explicitDir = process.env.STELLA_BROWSER_SOCKET_DIR?.trim();
  if (explicitDir) {
    return explicitDir;
  }

  const repoLocal = findRepoLocalStorageDir();
  if (repoLocal) {
    return repoLocal;
  }

  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'stella-browser');
  }

  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, '.stella-browser');
  }

  return path.join(os.tmpdir(), 'stella-browser');
}

export function getSocketDir(): string {
  return getAppDir();
}

function findRepoLocalStorageDir(): string | null {
  let current = process.cwd();
  let depth = 0;
  const homeDir = os.homedir();

  while (depth < 4) {
    if (current === homeDir) {
      break;
    }
    const candidate = path.join(current, '.stella');
    if (candidate && tryIsDirectory(candidate)) {
      return path.join(candidate, 'stella-browser');
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    depth += 1;
  }

  return null;
}

function tryIsDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
