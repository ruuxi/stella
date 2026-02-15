/**
 * Content script that keeps the MV3 service worker alive by maintaining
 * an active chrome.runtime.connect() port. Without this, Chrome terminates
 * the service worker after ~30s of inactivity, killing WebSocket connections.
 */

function openPort() {
  try {
    const port = chrome.runtime.connect({ name: 'keepalive' });
    port.onDisconnect.addListener(() => {
      // Service worker was terminated and restarted — reconnect after a short delay
      setTimeout(openPort, 1000);
    });
  } catch {
    // Extension context invalidated (e.g., extension was unloaded)
  }
}

openPort();
