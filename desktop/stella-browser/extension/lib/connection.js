/**
 * Native messaging connection to the Stella bridge (Chrome native host → localhost TCP).
 * Reconnects after disconnects and keeps the service worker warm via alarms.
 */

import { STELLA_NATIVE_HOST_NAME } from './native-host-name.js';

const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;

let nativePort = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_DELAY;
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
 * Connect via Chrome native messaging to the Stella native host (no port/token setup).
 */
export function connect() {
  if (isConnected()) return;
  doConnect();
}

/**
 * Disconnect from the bridge.
 */
export function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
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
    scheduleReconnect();
    return;
  }

  nativePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'welcome') {
      console.log('[connection] Authenticated, session:', msg.session);
      reconnectDelay = RECONNECT_DELAY;
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
      scheduleReconnect();
    }
  });

  port.postMessage({
    type: 'hello',
    version: '1.0.0',
    token: '',
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[connection] Reconnecting native messaging…');
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    doConnect();
  }, reconnectDelay);
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
    } else if (!reconnectTimer) {
      // Only attempt reconnect if no backoff timer is already pending.
      doConnect();
    }
  }
});
