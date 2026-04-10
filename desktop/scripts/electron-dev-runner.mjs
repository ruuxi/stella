import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const viteBinPath = resolve(desktopDir, 'node_modules', 'vite', 'bin', 'vite.js');
const viteDevUrlPath = resolve(desktopDir, '.vite-dev-url');
const pidFilePath = resolve(desktopDir, '.electron-dev-runner.pid');

if (!existsSync(viteBinPath)) {
  console.error(
    `[electron:dev] Missing Vite binary at ${viteBinPath}. Run your package install in desktop/ first.`,
  );
  process.exit(1);
}

try {
  rmSync(viteDevUrlPath, { force: true });
} catch {
  // Best-effort stale dev URL cleanup before Vite rewrites it for this run.
}

const writePidFile = () => {
  writeFileSync(
    pidFilePath,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
};

const removeOwnPidFile = () => {
  try {
    const raw = readFileSync(pidFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.pid !== process.pid) {
      return;
    }
    rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore stale or missing pid files during shutdown.
  }
};

writePidFile();

const processSpecs = [
  {
    name: 'vite',
    command: process.execPath,
    args: [viteBinPath],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  },
  {
    name: 'electron-build',
    command: process.execPath,
    args: [resolve(scriptDir, 'dev-electron-build.mjs')],
    env: process.env,
  },
  {
    name: 'electron-main',
    command: process.execPath,
    args: [resolve(scriptDir, 'dev-electron.mjs')],
    env: process.env,
  },
];

const activeChildren = new Map();
let shuttingDown = false;
let exitCode = 0;

function log(message) {
  console.log(`[electron:dev] ${message}`);
}

function logError(message) {
  console.error(`[electron:dev] ${message}`);
}

function waitForChildExit(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    child.once('exit', () => {
      resolvePromise();
    });
  });
}

async function killChildTree(child) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore fallback kill errors during shutdown.
        }
        resolvePromise();
      });
      killer.on('exit', () => {
        resolvePromise();
      });
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore kill errors during shutdown.
    }
  }
}

async function shutdownAll(trigger) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (trigger) {
    log(trigger);
  }

  const children = [...activeChildren.values()];
  await Promise.all(children.map(async ({ child }) => {
    await killChildTree(child);
    await waitForChildExit(child);
  }));

  removeOwnPidFile();
  process.exit(exitCode);
}

function handleRequiredFailure(spec, detail) {
  if (shuttingDown) {
    return;
  }
  exitCode = 1;
  void shutdownAll(`${spec.name} ${detail}; stopping electron dev.`);
}

function spawnProcess(spec) {
  log(`starting ${spec.name}`);
  const child = spawn(spec.command, spec.args, {
    cwd: desktopDir,
    env: spec.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  activeChildren.set(spec.name, { child, spec });

  child.on('error', (error) => {
    activeChildren.delete(spec.name);
    const detail = `failed to start: ${error instanceof Error ? error.message : String(error)}`;
    handleRequiredFailure(spec, detail);
  });

  child.on('exit', (code, signal) => {
    activeChildren.delete(spec.name);
    if (shuttingDown) {
      return;
    }

    const detail = signal ? `exited via ${signal}` : `exited with code ${code ?? 0}`;
    handleRequiredFailure(spec, detail);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    exitCode = 0;
    void shutdownAll(`received ${signal}`);
  });
}

process.on('exit', () => {
  removeOwnPidFile();
});

for (const spec of processSpecs) {
  spawnProcess(spec);
}
