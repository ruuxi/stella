/**
 * WebSocket connection manager with reconnection and keepalive.
 * Handles MV3 service worker lifecycle (termination after ~30s idle).
 */

const DEFAULT_PORT = 9224;
const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;

let ws = null;
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
 * Connect to the daemon's WebSocket server.
 * @param {number} [port] - Port number (default: 9224)
 * @param {string} [token] - Auth token for handshake
 */
export async function connect(port, token) {
  // Don't reconnect if already connected
  if (isConnected()) return;

  const config = await chrome.storage.local.get(['port', 'token']);
  const usePort = port ?? config.port ?? DEFAULT_PORT;
  const useToken = token ?? config.token ?? '';

  // Save config for reconnection after service worker restart
  await chrome.storage.local.set({ port: usePort, token: useToken });

  doConnect(usePort, useToken);
}

/**
 * Disconnect from the daemon.
 */
export function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.close(1000, 'user disconnect');
    ws = null;
  }
  setStatus(false);
}

/**
 * Check if connected.
 * @returns {boolean}
 */
export function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Send a response back to the daemon.
 * @param {object} message
 */
export function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function doConnect(port, token) {
  if (ws) {
    ws.close();
    ws = null;
  }

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    console.error('[connection] WebSocket creation failed:', err);
    scheduleReconnect(port, token);
    return;
  }

  ws = socket;

  // Helper to send on THIS specific socket (not module-level ws which may be clobbered)
  function sendOn(message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  socket.onopen = () => {
    console.log('[connection] Connected to daemon on port', port);
    reconnectDelay = RECONNECT_DELAY; // Reset backoff

    // Send handshake
    sendOn({
      type: 'hello',
      version: '1.0.0',
      token: token || '',
    });
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[connection] Invalid JSON:', event.data);
      return;
    }

    if (msg.type === 'welcome') {
      console.log('[connection] Authenticated, session:', msg.session);
      setStatus(true);
      // Store session token for reconnection
      if (msg.sessionToken) {
        await chrome.storage.local.set({ token: msg.sessionToken });
      }
      return;
    }

    if (msg.type === 'pong') {
      return; // Keepalive response, ignore
    }

    if (msg.type === 'auth_error') {
      console.error('[connection] Auth failed:', msg.error);
      setStatus(false);
      // Don't reconnect on auth failure
      return;
    }

    // It's a command from the daemon
    if (msg.type === 'command' && commandHandler) {
      try {
        const response = await commandHandler(msg);
        sendOn(response);
      } catch (err) {
        sendOn({
          type: 'response',
          id: msg.id,
          success: false,
          error: err.message || String(err),
        });
      }
    }
  };

  socket.onclose = (event) => {
    console.log('[connection] Disconnected:', event.code, event.reason);
    // Only clear module-level ws if this is still the active connection
    // (prevents stale onclose handlers from clobbering a newer connection)
    if (ws === socket) {
      ws = null;
      setStatus(false);
      if (event.code !== 1000) {
        // Not a clean close, try to reconnect
        scheduleReconnect(port, token);
      }
    }
  };

  socket.onerror = (err) => {
    console.error('[connection] WebSocket error:', err);
  };
}

function scheduleReconnect(port, token) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[connection] Reconnecting...');
    doConnect(port, token);
  }, reconnectDelay);

  // Exponential backoff
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function setStatus(connected) {
  // Update badge
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({
    color: connected ? '#22c55e' : '#ef4444',
  });

  if (statusCallback) {
    statusCallback(connected);
  }
}

// --- Keepalive ---

// Set up alarm to keep service worker alive and maintain WebSocket connection
chrome.alarms.create('keepalive', { periodInMinutes: 24 / 60 }); // Every 24 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    if (isConnected()) {
      send({ type: 'ping' });
    } else {
      // Try to reconnect
      const config = await chrome.storage.local.get(['port', 'token']);
      if (config.port) {
        doConnect(config.port, config.token || '');
      }
    }
  }
});
