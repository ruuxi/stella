import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
const BRIDGES_DIR = path.join(os.homedir(), '.stella', 'bridges');
const SIGKILL_TIMEOUT_MS = 5000;
const BRIDGE_STARTUP_GRACE_MS = 1200;
const processes = new Map();
const bridgeEnv = new Map();
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
async function runCommand(command, args, cwd, timeoutMs) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timeout);
            const details = err instanceof Error ? err.message : String(err);
            reject(new Error(`${command} ${args.join(' ')} failed to start: ${details}`));
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`));
        });
    });
}
export async function deploy(bundle) {
    const dir = path.join(BRIDGES_DIR, bundle.provider);
    try {
        await ensureDir(dir);
        bridgeEnv.set(bundle.provider, bundle.env);
        // Write bridge code
        await fs.writeFile(path.join(dir, 'bridge.js'), bundle.code, 'utf-8');
        // Install npm dependencies if any
        if (bundle.dependencies.trim()) {
            const pkgJson = {
                name: `stella-bridge-${bundle.provider}`,
                version: '1.0.0',
                private: true,
                dependencies: {},
            };
            for (const spec of bundle.dependencies.split(/\s+/).filter(Boolean)) {
                const trimmed = spec.trim();
                if (!trimmed)
                    continue;
                const atIndex = trimmed.startsWith('@')
                    ? trimmed.indexOf('@', 1)
                    : trimmed.lastIndexOf('@');
                const hasVersion = atIndex > 0 && atIndex < trimmed.length - 1;
                if (!hasVersion) {
                    throw new Error(`Unpinned dependency spec rejected: ${trimmed}`);
                }
                const name = hasVersion ? trimmed.slice(0, atIndex) : trimmed;
                const version = trimmed.slice(atIndex + 1);
                pkgJson.dependencies[name] = version;
            }
            await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');
            if (process.platform === 'win32') {
                await runCommand('cmd.exe', ['/d', '/s', '/c', 'npm install --production'], dir, 120000);
            }
            else {
                await runCommand('npm', ['install', '--production'], dir, 120000);
            }
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
export async function start(provider) {
    if (processes.has(provider)) {
        const existing = processes.get(provider);
        if (!existing.killed && existing.exitCode === null) {
            return { ok: true }; // Already running
        }
        processes.delete(provider);
    }
    const dir = path.join(BRIDGES_DIR, provider);
    const bridgePath = path.join(dir, 'bridge.js');
    const env = bridgeEnv.get(provider);
    try {
        await fs.access(bridgePath);
        if (!env) {
            return { ok: false, error: `Bridge environment is missing for provider ${provider}` };
        }
        const child = spawn('node', [bridgePath], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env: { ...process.env, ...env },
        });
        child.stdout?.on('data', (data) => {
            console.log(`[bridge:${provider}]`, data.toString().trimEnd());
        });
        child.stderr?.on('data', (data) => {
            console.error(`[bridge:${provider}]`, data.toString().trimEnd());
        });
        child.on('exit', (code) => {
            console.log(`[bridge:${provider}] Process exited with code ${code}`);
            processes.delete(provider);
        });
        child.on('error', (err) => {
            console.error(`[bridge:${provider}] Process error:`, err.message);
            processes.delete(provider);
        });
        processes.set(provider, child);
        const startupResult = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve({ ok: true });
            }, BRIDGE_STARTUP_GRACE_MS);
            const onError = (err) => {
                cleanup();
                resolve({ ok: false, error: err.message });
            };
            const onExit = (code) => {
                cleanup();
                const codeLabel = typeof code === 'number' ? String(code) : 'unknown';
                resolve({ ok: false, error: `Bridge process exited during startup (code ${codeLabel})` });
            };
            const cleanup = () => {
                clearTimeout(timer);
                child.off('error', onError);
                child.off('exit', onExit);
            };
            child.once('error', onError);
            child.once('exit', onExit);
        });
        if (!startupResult.ok) {
            try {
                child.kill('SIGTERM');
            }
            catch {
                // Already dead
            }
            processes.delete(provider);
            return startupResult;
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
export function stop(provider) {
    const child = processes.get(provider);
    if (!child)
        return { ok: true };
    try {
        child.kill('SIGTERM');
        // Fallback: force kill after timeout
        const killTimer = setTimeout(() => {
            try {
                if (!child.killed)
                    child.kill('SIGKILL');
            }
            catch {
                // Already dead
            }
        }, SIGKILL_TIMEOUT_MS);
        child.on('exit', () => clearTimeout(killTimer));
    }
    catch {
        // Already dead
    }
    processes.delete(provider);
    return { ok: true };
}
export function stopAll() {
    for (const [provider] of processes) {
        stop(provider);
    }
}
export function isRunning(provider) {
    const child = processes.get(provider);
    if (!child)
        return false;
    return !child.killed && child.exitCode === null;
}
