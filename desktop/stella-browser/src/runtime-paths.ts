import * as os from 'os';
import * as path from 'path';

/**
 * Get the base directory for socket/pid/state files.
 * Priority: STELLA_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.stella-browser > tmpdir
 */
export function getAppDir(): string {
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
  if (process.env.STELLA_BROWSER_SOCKET_DIR) {
    return process.env.STELLA_BROWSER_SOCKET_DIR;
  }
  return getAppDir();
}
