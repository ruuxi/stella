/**
 * Shared debugger management - attach/detach chrome.debugger and dispatch CDP events.
 * Used by interaction.js, network.js, capture.js (PDF), etc.
 */

const debuggerAttachments = new Map(); // tabId -> true
/**
 * Tabs that must stay attached regardless of idle time. A long-running capture
 * (HAR recording) receives CDP events without issuing commands, so the idle
 * timer would otherwise detach mid-recording and silently end it.
 */
const detachHolds = new Set(); // tabId
let detachTimer = null;
const DETACH_TIMEOUT = 300000; // Auto-detach after 5min idle

function scheduleIdleDetach() {
  // The handle is a bare number in the service worker, where `unref` is absent
  // and the optional call is a no-op; under Node (tests) it keeps this idle
  // timer from holding the process open for five minutes.
  clearTimeout(detachTimer);
  detachTimer = setTimeout(() => detachIdleDebuggers(), DETACH_TIMEOUT);
  detachTimer.unref?.();
}

/**
 * Keep a tab attached until the matching release. Safe to call repeatedly.
 * @param {number} tabId
 */
export function holdDebugger(tabId) {
  detachHolds.add(tabId);
}

/**
 * Drop a hold taken by `holdDebugger` and let the tab idle out again.
 * @param {number} tabId
 */
export function releaseDebugger(tabId) {
  detachHolds.delete(tabId);
}

/**
 * Detach every tab that is not explicitly held, then keep watching if any hold
 * remains so a released tab still idles out later.
 */
async function detachIdleDebuggers() {
  detachTimer = null;
  for (const [tabId] of [...debuggerAttachments]) {
    if (detachHolds.has(tabId)) continue;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Tab may have closed
    }
    debuggerAttachments.delete(tabId);
  }
  if (detachHolds.size > 0) scheduleIdleDetach();
}

/**
 * Ensure chrome.debugger is attached to the given tab.
 * @param {number} tabId
 */
export async function ensureDebugger(tabId) {
  if (!debuggerAttachments.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttachments.set(tabId, true);
  }
  scheduleIdleDetach();
}

/**
 * Evaluate an expression in the page and await promise results.
 * @param {number} tabId
 * @param {string} expression
 * @param {{userGesture?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<unknown>}
 */
export async function evaluateRuntime(tabId, expression, options = {}) {
  await ensureDebugger(tabId);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError('Runtime evaluation timeout must be between 1 and 30000ms');
  }
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  };
  if (options.userGesture === true) params.userGesture = true;
  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    params,
  );

  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Runtime evaluation failed';
    throw new Error(message);
  }

  return result.result?.value;
}

/**
 * Detach debugger from all tabs.
 */
export async function detachAllDebuggers() {
  clearTimeout(detachTimer);
  detachTimer = null;
  for (const [tabId] of debuggerAttachments) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Tab may have closed
    }
  }
  debuggerAttachments.clear();
  // An explicit teardown overrides every hold; leaving them would keep the
  // idle timer rescheduling forever against tabs that are no longer attached.
  detachHolds.clear();
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

// Global CDP event listener - dispatches to registered per-tab listeners.
// `source` is forwarded as a second argument because auto-attached targets
// (cross-origin iframes, workers) deliver events under the same tabId with a
// `sessionId`, and commands about those requests must carry it back.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const key = `${source.tabId}:${method}`;
  const listeners = eventListeners.get(key);
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(params, source);
      } catch (err) {
        console.error(`[debugger] Event listener error for ${method}:`, err);
      }
    }
  }
});

// Clean up on tab close. Dropping the hold matters: a closed tab that stayed
// held would keep the idle timer rescheduling against an attachment that can
// never be satisfied again.
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachments.delete(tabId);
  releaseDebugger(tabId);
  clearCdpEvents(tabId);
});

// Clean up when debugger is detached externally (e.g. user closes DevTools)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttachments.delete(source.tabId);
    releaseDebugger(source.tabId);
  }
});
