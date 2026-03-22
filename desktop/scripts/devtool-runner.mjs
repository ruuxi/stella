import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const devtoolDir = resolve(desktopDir, '..', 'devtool');
const viteBinPath = resolve(devtoolDir, 'node_modules', 'vite', 'bin', 'vite.js');
const optional = process.argv.includes('--optional');

function log(message) {
  console.log(`[devtool] ${message}`);
}

function logError(message) {
  console.error(`[devtool] ${message}`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      resolvePromise(code ?? 0);
    });
  });
}

async function ensureDevtoolDependencies() {
  if (existsSync(viteBinPath)) {
    return true;
  }

  const installAttempts = [
    { command: 'bun', args: ['install'], label: 'bun install' },
    { command: 'npm', args: ['install'], label: 'npm install' },
  ];

  for (const attempt of installAttempts) {
    try {
      log(`Missing devtool dependencies; trying ${attempt.label}...`);
      const exitCode = await runCommand(attempt.command, attempt.args, devtoolDir);
      if (exitCode === 0 && existsSync(viteBinPath)) {
        return true;
      }
    } catch (error) {
      logError(`${attempt.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return existsSync(viteBinPath);
}

async function main() {
  if (!(await ensureDevtoolDependencies())) {
    const message =
      'Devtool dependencies are unavailable, so the optional devtool server was not started.';
    if (optional) {
      logError(message);
      process.exit(0);
    }
    throw new Error(message);
  }

  const child = spawn(
    process.execPath,
    [viteBinPath, '--port', '17711', '--open'],
    {
      cwd: devtoolDir,
      stdio: 'inherit',
      env: process.env,
    },
  );

  const forwardSignal = (signal) => {
    if (!child.killed && child.exitCode === null) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', (error) => {
    const message = `Failed to start devtool: ${error instanceof Error ? error.message : String(error)}`;
    if (optional) {
      logError(message);
      process.exit(0);
      return;
    }
    logError(message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (optional) {
      if (code && code !== 0) {
        logError(`Devtool exited with code ${code}; continuing without it.`);
      }
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (optional) {
    logError(message);
    process.exit(0);
    return;
  }
  logError(message);
  process.exit(1);
});
