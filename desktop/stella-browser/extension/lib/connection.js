/**
 * Native messaging connection to the Stella bridge (Chrome native host → localhost TCP).
 *
 * connectNative spawns a native host process (plus a cmd.exe launcher on
 * Windows), so we never blind-reconnect: while disconnected we poll the
 * daemon's bridge port with a plain fetch() — zero processes — and only spawn
 * the host once Stella's daemon is actually listening. The host exits when the
 * daemon goes away, so nothing of Stella lingers in Task Manager when the app
 * is closed. An alarm keeps polling alive across service-worker suspensions.
 */

import { STELLA_NATIVE_HOST_NAME } from './native-host-name.js';

/** Must match the daemon's bridge port (STELLA_BROWSER_BRIDGE_PORT / DEFAULT_EXT_PORT). */
const BRIDGE_HEALTH_URL = 'http://127.0.0.1:39040/healthz';
const PROBE_INTERVAL = 4000;
const PROBE_TIMEOUT = 1500;

let nativePort = null;
let probeTimer = null;
let probeInFlight = false;
let commandHandler = null;
let statusCallback = null;

/**
 * Set the handler for incoming commands from the daemon.
 * @param {(command: object) => Promise<object>} handler
 */
export function onCommand(handler) {
  commandHandler = handler;
}

/**
 * Set the callback for connection status changes.
 * @param {(connected: boolean) => void} callback
 */
export function onStatus(callback) {
  statusCallback = callback;
}

/**
 * Connect to the Stella bridge: probe for the daemon and attach via native
 * messaging once it's up (no port/token setup).
 */
export function connect() {
  if (isConnected()) return;
  probeThenConnect();
}

/**
 * Disconnect from the bridge.
 */
export function disconnect() {
  clearTimeout(probeTimer);
  probeTimer = null;
  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch {
      // ignore
    }
    nativePort = null;
  }
  setStatus(false);
}

/**
 * @returns {boolean}
 */
export function isConnected() {
  return nativePort !== null;
}

/**
 * @param {object} message
 */
export function send(message) {
  if (nativePort) {
    try {
      nativePort.postMessage(message);
    } catch {
      // ignore
    }
  }
}

/**
 * Check whether the Stella daemon is listening on the bridge port.
 * Any HTTP response means it's up. An abort (something accepted the
 * connection but never spoke HTTP) is treated as up too — that's an older
 * daemon build that predates the health endpoint. A fast network error
 * means nothing is listening (Stella is closed).
 * @returns {Promise<boolean>}
 */
async function isDaemonUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    await fetch(BRIDGE_HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
    return true;
  } catch (err) {
    return err?.name === 'AbortError';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe for the daemon; attach via native messaging when it's up, otherwise
 * keep polling. fetch() is process-free, so Stella being closed costs nothing.
 */
async function probeThenConnect() {
  if (probeInFlight || isConnected()) return;
  clearTimeout(probeTimer);
  probeTimer = null;

  probeInFlight = true;
  let up = false;
  try {
    up = await isDaemonUp();
  } finally {
    probeInFlight = false;
  }

  if (isConnected()) return;
  if (up) {
    doConnect();
    return;
  }
  scheduleProbe();
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeThenConnect();
  }, PROBE_INTERVAL);
}

function doConnect() {
  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch {
      // ignore
    }
    nativePort = null;
  }

  let port;
  try {
    port = chrome.runtime.connectNative(STELLA_NATIVE_HOST_NAME);
  } catch (err) {
    console.error('[connection] connectNative failed:', err);
    scheduleProbe();
    return;
  }

  nativePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'welcome') {
      console.log('[connection] Authenticated, session:', msg.session);
      setStatus(true);
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'auth_error') {
      console.error('[connection] Auth failed:', msg.error);
      setStatus(false);
      return;
    }

    if (msg.type === 'command' && commandHandler) {
      try {
        const response = await commandHandler(msg);
        send(response);
      } catch (err) {
        send({
          type: 'response',
          id: msg.id,
          success: false,
          error: err.message || String(err),
        });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err?.message) {
      console.error('[connection] Native port disconnected:', err.message);
    }
    const wasActive = nativePort === port;
    nativePort = null;
    if (wasActive) {
      setStatus(false);
      // Host exited (Stella closed, or the daemon restarted). Go back to
      // process-free polling; we reattach as soon as the daemon answers.
      probeThenConnect();
    }
  });

  port.postMessage({
    type: 'hello',
    version: '1.0.0',
    token: '',
  });
}

function setStatus(connected) {
  chrome.action.setBadgeText({ text: '' });

  if (statusCallback) {
    statusCallback(connected);
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 24 / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (isConnected()) {
      send({ type: 'ping' });
    } else {
      // The alarm revives a suspended service worker (which loses its probe
      // timer); probeThenConnect dedupes against any pending timer/probe.
      probeThenConnect();
    }
  }
});
