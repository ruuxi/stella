import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const repoRootDir = resolve(desktopDir, '..');
const runnerScriptPath = resolve(scriptDir, 'electron-dev-runner.mjs');
const runnerPidFilePath = resolve(desktopDir, '.electron-dev-runner.pid');
const stellaStatePath = resolve(repoRootDir, 'state');
const devElectronBinaryPathFragments = [
  resolve(desktopDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  resolve(desktopDir, '.stella-dev-runtime', 'Stella.app', 'Contents', 'MacOS', 'Electron'),
].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const stellaSqlitePaths = [
  'stella.sqlite',
  'stella.sqlite-shm',
  'stella.sqlite-wal',
].map((relativePath) => resolve(stellaStatePath, relativePath));

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const killWindowsTree = (pid) =>
  new Promise((resolvePromise) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', resolvePromise);
    killer.on('exit', resolvePromise);
  });

const waitForExit = async (pid, timeoutMs = 5000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } catch {
      return;
    }
  }
};

const killPosixTree = async (pid) => {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }

  await waitForExit(pid, 2500);

  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
};

const stopExistingDevRunner = async () => {
  if (!(await pathExists(runnerPidFilePath))) {
    return false;
  }

  try {
    const raw = await fs.readFile(runnerPidFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);

    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      await fs.rm(runnerPidFilePath, { force: true });
      return false;
    }

    try {
      process.kill(pid, 0);
    } catch {
      await fs.rm(runnerPidFilePath, { force: true });
      return false;
    }

    if (process.platform === 'win32') {
      await killWindowsTree(pid);
    } else {
      await killPosixTree(pid);
    }

    await fs.rm(runnerPidFilePath, { force: true });
    return true;
  } catch {
    await fs.rm(runnerPidFilePath, { force: true });
    return false;
  }
};

const stopResidualDevElectron = async () => {
  if (process.platform === 'win32') {
    return 0;
  }

  const matchedPids = new Set();

  for (const pathFragment of devElectronBinaryPathFragments) {
    let stdout = '';
    try {
      stdout = execFileSync(
        'pgrep',
        [
          '-f',
          pathFragment,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
        continue;
      }
      continue;
    }

    stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      .forEach((pid) => matchedPids.add(pid));
  }

  const pids = [...matchedPids];

  await Promise.allSettled(pids.map((pid) => killPosixTree(pid)));
  return pids.length;
};

const clearSqlitePaths = async () => {
  await Promise.allSettled(
    stellaSqlitePaths.map((targetPath) => fs.rm(targetPath, { force: true })),
  );
};

const main = async () => {
  if (!existsSync(runnerScriptPath)) {
    throw new Error(`Missing runner script: ${runnerScriptPath}`);
  }

  const stoppedRunner = await stopExistingDevRunner();
  const stoppedResidualElectron = await stopResidualDevElectron();

  await clearSqlitePaths();

  console.log(
    [
      '[reset-sql] Removed Stella SQLite under state/ (stella.sqlite + -shm + -wal).',
      `Target: ${stellaStatePath}`,
      stoppedRunner ? 'Stopped the existing dev runner.' : '',
      stoppedResidualElectron > 0
        ? `Stopped ${stoppedResidualElectron} residual Electron dev process${stoppedResidualElectron === 1 ? '' : 'es'}.`
        : '',
    ].filter(Boolean).join('\n'),
  );
};

await main();
