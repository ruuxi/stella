/**
 * Integration tests for Chrome extension commands.
 *
 * Prerequisites:
 *   1. Start daemon in extension mode:
 *      AGENT_BROWSER_USER_BROWSER=1 AGENT_BROWSER_HEADED=1 node dist/daemon.js
 *   2. Extension must be connected (auto-connects on Chrome relaunch)
 *
 * Run:
 *   pnpm test -- test/extension-commands.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Helpers ---

function getPortFile(): string {
  const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    || path.join(os.homedir(), '.agent-browser');
  const session = process.env.AGENT_BROWSER_SESSION || 'default';
  return path.join(socketDir, `${session}.port`);
}

let commandCounter = 0;

function makeId(prefix: string): string {
  return `${prefix}_${++commandCounter}`;
}

function sendCommand(socket: net.Socket, command: Record<string, unknown>): Promise<any> {
  const id = command.id as string || makeId(command.action as string);
  const msg = JSON.stringify({ id, ...command }) + '\n';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`Command '${command.action}' timed out after 30s`));
    }, 30000);

    let buffer = '';

    function handler(data: Buffer) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Process complete lines
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
      // Keep incomplete last line in buffer
      buffer = lines[lines.length - 1];
    }

    socket.on('data', handler);
    socket.write(msg);
  });
}

// --- Test Suite ---

const portFile = getPortFile();
const canRun = fs.existsSync(portFile);

describe.skipIf(!canRun)('Extension Commands', () => {
  let socket: net.Socket;

  beforeAll(async () => {
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim());
    socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('error', reject);
    });

    // Navigate to a known test page
    const nav = await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
    expect(nav.success).toBe(true);
    // Wait for page to settle
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  afterAll(() => {
    socket?.end();
  });

  // ==========================================
  // Group 1: Element Queries
  // ==========================================

  it('innertext — gets visible text of element', async () => {
    const res = await sendCommand(socket, { action: 'innertext', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.text).toContain('Example Domain');
  });

  it('innerhtml — gets HTML content of element', async () => {
    const res = await sendCommand(socket, { action: 'innerhtml', selector: 'div' });
    expect(res.success).toBe(true);
    expect(res.data.html).toContain('<h1>');
  });

  it('boundingbox — gets element position and size', async () => {
    const res = await sendCommand(socket, { action: 'boundingbox', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.box).toHaveProperty('x');
    expect(res.data.box).toHaveProperty('y');
    expect(res.data.box).toHaveProperty('width');
    expect(res.data.box).toHaveProperty('height');
    expect(res.data.box.width).toBeGreaterThan(0);
  });

  it('isvisible — checks element visibility', async () => {
    const res = await sendCommand(socket, { action: 'isvisible', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.visible).toBe(true);
  });

  it('isenabled — checks element enabled state', async () => {
    const res = await sendCommand(socket, { action: 'isenabled', selector: 'a' });
    expect(res.success).toBe(true);
    expect(res.data.enabled).toBe(true);
  });

  it('count — counts matching elements', async () => {
    const res = await sendCommand(socket, { action: 'count', selector: 'p' });
    expect(res.success).toBe(true);
    expect(res.data.count).toBeGreaterThan(0);
  });

  it('scrollintoview — scrolls element into view', async () => {
    const res = await sendCommand(socket, { action: 'scrollintoview', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.scrolled).toBe(true);
  });

  it('styles — gets computed styles', async () => {
    const res = await sendCommand(socket, { action: 'styles', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.elements).toBeInstanceOf(Array);
    expect(res.data.elements.length).toBe(1);
    expect(res.data.elements[0].styles).toHaveProperty('fontSize');
    expect(res.data.elements[0].styles).toHaveProperty('color');
  });

  it('waitforurl — waits for current URL to match', async () => {
    const res = await sendCommand(socket, {
      action: 'waitforurl',
      url: '*example.com*',
      timeout: 5000,
    });
    expect(res.success).toBe(true);
    expect(res.data.url).toContain('example.com');
  });

  it('bringtofront — focuses the tab', async () => {
    const res = await sendCommand(socket, { action: 'bringtofront' });
    expect(res.success).toBe(true);
    expect(res.data.focused).toBe(true);
  });

  // ==========================================
  // Group 2: Network
  // ==========================================

  it('requests — starts tracking and returns network requests', async () => {
    // Start tracking
    const start = await sendCommand(socket, { action: 'requests' });
    expect(start.success).toBe(true);

    // Navigate to trigger requests
    await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
    await new Promise(r => setTimeout(r, 1000));

    // Get tracked requests
    const res = await sendCommand(socket, { action: 'requests' });
    expect(res.success).toBe(true);
    expect(res.data.requests).toBeInstanceOf(Array);
    expect(res.data.requests.length).toBeGreaterThan(0);

    // Should have captured the navigation request
    const mainReq = res.data.requests.find((r: any) => r.url.includes('example.com'));
    expect(mainReq).toBeTruthy();
  });

  it('requests clear — clears tracked requests', async () => {
    const res = await sendCommand(socket, { action: 'requests', clear: true });
    expect(res.success).toBe(true);
    expect(res.data.cleared).toBe(true);
  });

  it('route — sets up request interception', async () => {
    const res = await sendCommand(socket, {
      action: 'route',
      url: '*://test-blocked.example.com/*',
      abort: true,
    });
    expect(res.success).toBe(true);
    expect(res.data.routed).toBeTruthy();
  });

  it('unroute — removes request interception', async () => {
    const res = await sendCommand(socket, {
      action: 'unroute',
      url: '*://test-blocked.example.com/*',
    });
    expect(res.success).toBe(true);
    expect(res.data.unrouted).toBeTruthy();
  });

  it('har_start / har_stop — records HAR', async () => {
    const start = await sendCommand(socket, { action: 'har_start' });
    expect(start.success).toBe(true);

    // Navigate to generate traffic
    await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
    await new Promise(r => setTimeout(r, 1000));

    const stop = await sendCommand(socket, { action: 'har_stop' });
    expect(stop.success).toBe(true);
    expect(stop.data.requestCount).toBeGreaterThan(0);
    expect(stop.data.log).toHaveProperty('version');
    expect(stop.data.log.entries).toBeInstanceOf(Array);
  });

  // ==========================================
  // Group 3: PDF, Downloads, Clipboard
  // ==========================================

  it('pdf — generates PDF of current page', async () => {
    // Navigate back to example.com first
    await sendCommand(socket, { action: 'navigate', url: 'https://example.com' });
    await new Promise(r => setTimeout(r, 500));

    const res = await sendCommand(socket, { action: 'pdf' });
    expect(res.success).toBe(true);
    expect(res.data.base64).toBeTruthy();
    expect(typeof res.data.base64).toBe('string');
    expect(res.data.base64.length).toBeGreaterThan(100);
    // PDF magic bytes in base64: JVBERi0 = %PDF-
    expect(res.data.base64.startsWith('JVBERi0')).toBe(true);
  });

  it('clipboard copy — sends Ctrl+C', async () => {
    const res = await sendCommand(socket, { action: 'clipboard', operation: 'copy' });
    expect(res.success).toBe(true);
    expect(res.data.copied).toBe(true);
  });

  it('clipboard paste — sends Ctrl+V', async () => {
    const res = await sendCommand(socket, { action: 'clipboard', operation: 'paste' });
    expect(res.success).toBe(true);
    expect(res.data.pasted).toBe(true);
  });

  // ==========================================
  // Group 4: Advanced Input
  // ==========================================

  it('mousemove — moves mouse to coordinates', async () => {
    const res = await sendCommand(socket, { action: 'mousemove', x: 200, y: 200 });
    expect(res.success).toBe(true);
    expect(res.data.moved).toBe(true);
    expect(res.data.x).toBe(200);
    expect(res.data.y).toBe(200);
  });

  it('mousedown / mouseup — press and release', async () => {
    const down = await sendCommand(socket, { action: 'mousedown', x: 100, y: 100 });
    expect(down.success).toBe(true);
    expect(down.data.pressed).toBe(true);

    const up = await sendCommand(socket, { action: 'mouseup', x: 100, y: 100 });
    expect(up.success).toBe(true);
    expect(up.data.released).toBe(true);
  });

  it('keydown / keyup — individual key events', async () => {
    const down = await sendCommand(socket, { action: 'keydown', key: 'Shift' });
    expect(down.success).toBe(true);
    expect(down.data.keydown).toBe('Shift');

    const up = await sendCommand(socket, { action: 'keyup', key: 'Shift' });
    expect(up.success).toBe(true);
    expect(up.data.keyup).toBe('Shift');
  });

  it('inserttext — inserts text at cursor', async () => {
    // This won't visually do much without a focused input, but it should succeed
    const res = await sendCommand(socket, { action: 'inserttext', text: 'hello' });
    expect(res.success).toBe(true);
    expect(res.data.inserted).toBe(true);
  });

  it('drag — drags from one point to another', async () => {
    const res = await sendCommand(socket, {
      action: 'drag',
      startX: 100, startY: 100,
      endX: 300, endY: 300,
      steps: 5,
    });
    expect(res.success).toBe(true);
    expect(res.data.dragged).toBe(true);
  });

  // ==========================================
  // Existing commands still work
  // ==========================================

  it('url — gets current page URL', async () => {
    const res = await sendCommand(socket, { action: 'url' });
    expect(res.success).toBe(true);
    expect(res.data.url).toContain('example.com');
  });

  it('title — gets page title', async () => {
    const res = await sendCommand(socket, { action: 'title' });
    expect(res.success).toBe(true);
    expect(res.data.title).toContain('Example Domain');
  });

  it('screenshot — captures viewport', async () => {
    const res = await sendCommand(socket, { action: 'screenshot' });
    expect(res.success).toBe(true);
    expect(res.data.base64).toBeTruthy();
    expect(res.data.base64.length).toBeGreaterThan(100);
  });

  it('gettext — gets text content', async () => {
    const res = await sendCommand(socket, { action: 'gettext', selector: 'h1' });
    expect(res.success).toBe(true);
    expect(res.data.text).toContain('Example Domain');
  });

  it('tab_list — lists open tabs', async () => {
    const res = await sendCommand(socket, { action: 'tab_list' });
    expect(res.success).toBe(true);
    expect(res.data.tabs).toBeInstanceOf(Array);
    expect(res.data.tabs.length).toBeGreaterThan(0);
  });
});
