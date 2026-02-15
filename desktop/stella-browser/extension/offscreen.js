/**
 * Offscreen document that keeps the MV3 service worker alive
 * by maintaining an active chrome.runtime.connect() port.
 */
function openPort() {
  try {
    const port = chrome.runtime.connect({ name: 'keepalive' });
    port.onDisconnect.addListener(() => {
      // Service worker restarted — reconnect after a short delay
      setTimeout(openPort, 1000);
    });
  } catch {
    // Extension context invalidated
  }
}

openPort();
