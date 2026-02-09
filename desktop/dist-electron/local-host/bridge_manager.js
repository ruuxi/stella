import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
const BRIDGES_DIR = path.join(os.homedir(), '.stella', 'bridges');
const SIGKILL_TIMEOUT_MS = 5000;
const processes = new Map();
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
            reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        });
    });
}
export async function deploy(bundle) {
    const dir = path.join(BRIDGES_DIR, bundle.provider);
    try {
        await ensureDir(dir);
        // Write bridge code and config
        await fs.writeFile(path.join(dir, 'bridge.js'), bundle.code, 'utf-8');
        await fs.writeFile(path.join(dir, 'config.json'), bundle.config, 'utf-8');
        // Install npm dependencies if any
        if (bundle.dependencies.trim()) {
            const pkgJson = {
                name: `stella-bridge-${bundle.provider}`,
                version: '1.0.0',
                private: true,
                dependencies: {},
            };
            for (const dep of bundle.dependencies.split(/\s+/).filter(Boolean)) {
                pkgJson.dependencies[dep] = '*';
            }
            await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');
            const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            await runCommand(npmCommand, ['install', '--production'], dir, 120000);
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
export function start(provider) {
    if (processes.has(provider)) {
        const existing = processes.get(provider);
        if (!existing.killed && existing.exitCode === null) {
            return { ok: true }; // Already running
        }
        processes.delete(provider);
    }
    const dir = path.join(BRIDGES_DIR, provider);
    const bridgePath = path.join(dir, 'bridge.js');
    try {
        const child = spawn('node', [bridgePath], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
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
