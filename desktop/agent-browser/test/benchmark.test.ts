/**
 * Benchmark: Sequential vs Chain command performance.
 *
 * Measures the wall-clock time improvement from using chain commands
 * instead of individual sequential commands.
 *
 * Prerequisites:
 *   1. Start daemon in extension mode:
 *      AGENT_BROWSER_USER_BROWSER=1 AGENT_BROWSER_HEADED=1 node dist/daemon.js
 *   2. Extension must be connected
 *
 * Run:
 *   pnpm test -- test/benchmark.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Helpers (same pattern as extension-commands.test.ts) ---

function getPortFile(): string {
  const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    || path.join(os.homedir(), '.agent-browser');
  const session = process.env.AGENT_BROWSER_SESSION || 'default';
  return path.join(socketDir, `${session}.port`);
}

let commandCounter = 0;

function makeId(prefix: string): string {
  return `bench_${prefix}_${++commandCounter}`;
}

function sendCommand(socket: net.Socket, command: Record<string, unknown>): Promise<any> {
  const id = command.id as string || makeId(command.action as string);
  const msg = JSON.stringify({ id, ...command }) + '\n';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`Command '${command.action}' timed out after 60s`));
    }, 60000);

    let buffer = '';

    function handler(data: Buffer) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            socket.removeListener('data', handler);
            resolve(parsed);
            return;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
      buffer = lines[lines.length - 1];
    }

    socket.on('data', handler);
    socket.write(msg);
  });
}

// --- Benchmark ---

const portFile = getPortFile();
const canRun = fs.existsSync(portFile);

describe.skipIf(!canRun)('Chain Benchmark', () => {
  let socket: net.Socket;

  beforeAll(async () => {
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim());
    socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('error', reject);
    });
    // Navigate to example.com to warm up
    await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
  }, 30000);

  afterAll(() => {
    socket?.end();
  });

  it('sequential vs chain: multi-step interaction flow', async () => {
    // ============================================
    // SEQUENTIAL: 6 individual commands
    // ============================================
    // Navigate to about:blank first to reset state
    await sendCommand(socket, { action: 'navigate', url: 'about:blank' });
    await new Promise(r => setTimeout(r, 500));

    const seqStart = Date.now();

    // Step 1: Navigate
    const nav1 = await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
    expect(nav1.success).toBe(true);

    // Step 2: Snapshot
    const snap1 = await sendCommand(socket, { action: 'snapshot', interactive: true, compact: true });
    expect(snap1.success).toBe(true);

    // Step 3: Get text of h1
    const text1 = await sendCommand(socket, { action: 'innertext', selector: 'h1' });
    expect(text1.success).toBe(true);

    // Step 4: Check visibility
    const vis1 = await sendCommand(socket, { action: 'isvisible', selector: 'h1' });
    expect(vis1.success).toBe(true);

    // Step 5: Get bounding box
    const box1 = await sendCommand(socket, { action: 'boundingbox', selector: 'h1' });
    expect(box1.success).toBe(true);

    // Step 6: Screenshot
    const shot1 = await sendCommand(socket, { action: 'screenshot' });
    expect(shot1.success).toBe(true);

    const seqDuration = Date.now() - seqStart;

    // ============================================
    // CHAIN: same 6 steps as one command
    // ============================================
    // Reset state
    await sendCommand(socket, { action: 'navigate', url: 'about:blank' });
    await new Promise(r => setTimeout(r, 500));

    const chainStart = Date.now();

    const chainResult = await sendCommand(socket, {
      action: 'chain',
      steps: [
        { action: 'navigate', url: 'https://example.com' },
        { action: 'snapshot', interactive: true, compact: true },
        { action: 'innertext', selector: 'h1' },
        { action: 'isvisible', selector: 'h1' },
        { action: 'boundingbox', selector: 'h1' },
        { action: 'screenshot' },
      ],
      delay: { min: 50, max: 150 }, // Minimal delays for benchmarking
    });

    const chainDuration = Date.now() - chainStart;

    // ============================================
    // RESULTS
    // ============================================
    expect(chainResult.success).toBe(true);
    expect(chainResult.data.completed).toBe(6);
    expect(chainResult.data.total).toBe(6);

    const speedup = seqDuration / chainDuration;
    const saved = seqDuration - chainDuration;

    console.log('\n');
    console.log('╔══════════════════════════════════════╗');
    console.log('║       BENCHMARK RESULTS              ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Sequential:  ${String(seqDuration).padStart(6)}ms              ║`);
    console.log(`║  Chain:       ${String(chainDuration).padStart(6)}ms              ║`);
    console.log(`║  Speedup:     ${speedup.toFixed(2).padStart(6)}x              ║`);
    console.log(`║  Saved:       ${String(saved).padStart(6)}ms              ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('\n');

    // Per-step timing breakdown
    console.log('Chain step breakdown:');
    for (const result of chainResult.data.results) {
      const status = result.success ? '✓' : '✗';
      console.log(`  ${status} Step ${result.step} (${result.action}): ${result.durationMs}ms`);
    }
    console.log(`  Total chain time: ${chainResult.data.totalDurationMs}ms`);
    console.log('\n');

    // Chain should be faster than sequential
    // (Even with small delays, eliminating round trips should win)
    expect(chainDuration).toBeLessThan(seqDuration);
  }, 120000);

  it('chain with returnSnapshot and returnScreenshot', async () => {
    const result = await sendCommand(socket, {
      action: 'chain',
      steps: [
        { action: 'navigate', url: 'https://example.com' },
        { action: 'innertext', selector: 'h1' },
      ],
      delay: { min: 50, max: 100 },
      returnSnapshot: true,
      returnScreenshot: true,
    });

    expect(result.success).toBe(true);
    expect(result.data.completed).toBe(2);
    expect(result.data.snapshot).toBeTruthy();
    expect(result.data.screenshot).toBeTruthy();
    // Verify snapshot contains expected content
    expect(result.data.snapshot).toContain('link');
  }, 60000);

  it('chain aborts on error by default', async () => {
    const result = await sendCommand(socket, {
      action: 'chain',
      steps: [
        { action: 'innertext', selector: '#nonexistent-element-12345' },
        { action: 'screenshot' }, // Should not execute
      ],
      delay: { min: 0, max: 0 },
    });

    expect(result.success).toBe(false);
    expect(result.data.completed).toBe(0);
    expect(result.data.results).toHaveLength(1); // Only first step attempted
    expect(result.data.results[0].success).toBe(false);
  }, 30000);

  it('chain continues on error with abortOnError=false', async () => {
    const result = await sendCommand(socket, {
      action: 'chain',
      steps: [
        { action: 'innertext', selector: '#nonexistent-element-12345' },
        { action: 'screenshot' }, // Should still execute
      ],
      delay: { min: 0, max: 0 },
      abortOnError: false,
    });

    expect(result.success).toBe(false); // Overall fails because step 0 failed
    expect(result.data.completed).toBe(1); // Screenshot succeeded
    expect(result.data.results).toHaveLength(2); // Both steps attempted
    expect(result.data.results[0].success).toBe(false);
    expect(result.data.results[1].success).toBe(true);
  }, 30000);
});
