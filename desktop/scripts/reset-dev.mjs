import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const repoRoot = resolve(desktopDir, '..');
const runnerScriptPath = resolve(scriptDir, 'electron-dev-runner.mjs');
const runnerPidFilePath = resolve(desktopDir, '.electron-dev-runner.pid');
const stellaHomePath = resolve(repoRoot, '.stella');
const desktopGeneratedPaths = [
  resolve(desktopDir, '.vite-dev-url'),
  resolve(desktopDir, '.stella-hmr-state.json'),
  resolve(desktopDir, 'dist-electron'),
];

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

const clearPaths = async (paths) => {
  await Promise.allSettled(
    paths.map((targetPath) =>
      fs.rm(targetPath, {
        recursive: true,
        force: true,
      }),
    ),
  );
};

const startDevRunner = () => {
  const child = spawn(process.execPath, [runnerScriptPath], {
    cwd: desktopDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
};

const main = async () => {
  if (!existsSync(runnerScriptPath)) {
    throw new Error(`Missing runner script: ${runnerScriptPath}`);
  }

  const stoppedRunner = await stopExistingDevRunner();

  await clearPaths([
    stellaHomePath,
    ...desktopGeneratedPaths,
  ]);

  startDevRunner();

  console.log(
    [
      '[reset] Fresh Stella desktop dev session started.',
      `Cleared ${stellaHomePath}`,
      stoppedRunner
        ? 'Stopped and restarted the existing dev runner.'
        : 'Started a new dev runner.',
    ].join('\n'),
  );
};

await main();
