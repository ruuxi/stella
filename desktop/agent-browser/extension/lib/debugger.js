/**
 * Shared debugger management — attach/detach chrome.debugger and dispatch CDP events.
 * Used by interaction.js, network.js, capture.js (PDF), etc.
 */

const debuggerAttachments = new Map(); // tabId -> true
let detachTimer = null;
const DETACH_TIMEOUT = 300000; // Auto-detach after 5min idle

/**
 * Ensure chrome.debugger is attached to the given tab.
 * @param {number} tabId
 */
export async function ensureDebugger(tabId) {
  if (!debuggerAttachments.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttachments.set(tabId, true);
  }
  // Reset auto-detach timer
  clearTimeout(detachTimer);
  detachTimer = setTimeout(() => detachAllDebuggers(), DETACH_TIMEOUT);
}

/**
 * Detach debugger from all tabs.
 */
export async function detachAllDebuggers() {
  for (const [tabId] of debuggerAttachments) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Tab may have closed
    }
  }
  debuggerAttachments.clear();
}

/**
 * Check if debugger is attached to a tab.
 * @param {number} tabId
 * @returns {boolean}
 */
export function isDebuggerAttached(tabId) {
  return debuggerAttachments.has(tabId);
}

// --- CDP Event Dispatch ---

// Map of "tabId:method" -> Set<callback>
const eventListeners = new Map();

/**
 * Register a listener for a CDP event on a specific tab.
 * @param {number} tabId
 * @param {string} method - CDP event method (e.g. 'Network.requestWillBeSent')
 * @param {(params: any) => void} callback
 */
export function onCdpEvent(tabId, method, callback) {
  const key = `${tabId}:${method}`;
  if (!eventListeners.has(key)) {
    eventListeners.set(key, new Set());
  }
  eventListeners.get(key).add(callback);
}

/**
 * Remove a listener for a CDP event on a specific tab.
 * @param {number} tabId
 * @param {string} method
 * @param {(params: any) => void} callback
 */
export function offCdpEvent(tabId, method, callback) {
  const key = `${tabId}:${method}`;
  const listeners = eventListeners.get(key);
  if (listeners) {
    listeners.delete(callback);
    if (listeners.size === 0) eventListeners.delete(key);
  }
}

/**
 * Remove all CDP event listeners for a specific tab.
 * @param {number} tabId
 */
export function clearCdpEvents(tabId) {
  for (const key of eventListeners.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      eventListeners.delete(key);
    }
  }
}

// Global CDP event listener — dispatches to registered per-tab listeners
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const key = `${source.tabId}:${method}`;
  const listeners = eventListeners.get(key);
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(params);
      } catch (err) {
        console.error(`[debugger] Event listener error for ${method}:`, err);
      }
    }
  }
});

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachments.delete(tabId);
  clearCdpEvents(tabId);
});

// Clean up when debugger is detached externally (e.g. user closes DevTools)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttachments.delete(source.tabId);
  }
});
