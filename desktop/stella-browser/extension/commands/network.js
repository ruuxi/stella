/**
 * Network command handlers: requests, responsebody, route, unroute, har_start, har_stop.
 * Uses chrome.debugger CDP domains: Network (tracking), Fetch (interception).
 */
import { ensureDebugger, onCdpEvent, offCdpEvent, clearCdpEvents } from '../lib/debugger.js';
import { getActiveTab } from './tabs.js';

// Per-tab tracking state
const trackedRequests = new Map();  // tabId -> { requests: [], tracking: true }
const activeRoutes = new Map();     // tabId -> Map<pattern, { response?, abort? }>
const harRecording = new Map();     // tabId -> { entries: [], startTime }

// --- Request Tracking ---

function startTracking(tabId) {
  if (trackedRequests.has(tabId)) return; // Already tracking

  trackedRequests.set(tabId, { requests: [], tracking: true });

  onCdpEvent(tabId, 'Network.requestWillBeSent', (params) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    state.requests.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      timestamp: params.timestamp,
      type: params.type,
      status: null,
      responseHeaders: null,
    });
  });

  onCdpEvent(tabId, 'Network.responseReceived', (params) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const req = state.requests.find(r => r.requestId === params.requestId);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.responseHeaders = params.response.headers;
      req.mimeType = params.response.mimeType;
      req.responseSize = params.response.encodedDataLength;
    }
  });
}

export async function handleRequests(command) {
  const tab = await getActiveTab();

  if (command.clear) {
    trackedRequests.delete(tab.id);
    return { id: command.id, success: true, data: { cleared: true } };
  }

  // Start tracking if not already
  if (!trackedRequests.has(tab.id)) {
    await ensureDebugger(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
    startTracking(tab.id);
  }

  const state = trackedRequests.get(tab.id);
  let requests = state ? state.requests : [];

  // Apply filter if provided
  if (command.filter) {
    const filter = command.filter.toLowerCase();
    requests = requests.filter(r =>
      r.url.toLowerCase().includes(filter) ||
      (r.method && r.method.toLowerCase().includes(filter))
    );
  }

  return {
    id: command.id,
    success: true,
    data: {
      requests: requests.map(r => ({
        url: r.url,
        method: r.method,
        status: r.status,
        type: r.type,
        mimeType: r.mimeType,
        requestId: r.requestId,
      })),
    },
  };
}

// --- Response Body ---

export async function handleResponseBody(command) {
  const tab = await getActiveTab();
  const requestId = command.requestId;
  if (!requestId) throw new Error('requestId is required for responsebody');

  await ensureDebugger(tab.id);
  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    'Network.getResponseBody',
    { requestId }
  );

  return {
    id: command.id,
    success: true,
    data: {
      body: result.body,
      base64Encoded: result.base64Encoded,
    },
  };
}

// --- Route / Unroute (Fetch interception) ---

/**
 * Check if a URL matches a glob-style pattern.
 */
function urlMatchesPattern(url, pattern) {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  return regex.test(url);
}

export async function handleRoute(command) {
  const tab = await getActiveTab();
  const pattern = command.url;
  if (!pattern) throw new Error('URL pattern is required for route');

  await ensureDebugger(tab.id);

  // Store route config
  if (!activeRoutes.has(tab.id)) {
    activeRoutes.set(tab.id, new Map());

    // Set up the Fetch.requestPaused handler once per tab
    onCdpEvent(tab.id, 'Fetch.requestPaused', async (params) => {
      const routes = activeRoutes.get(tab.id);
      if (!routes) return;

      // Find matching route
      let matched = null;
      for (const [routePattern, config] of routes) {
        if (urlMatchesPattern(params.request.url, routePattern)) {
          matched = config;
          break;
        }
      }

      try {
        if (matched) {
          if (matched.abort) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.failRequest', {
              requestId: params.requestId,
              errorReason: 'BlockedByClient',
            });
          } else if (matched.response) {
            const body = matched.response.body
              ? btoa(typeof matched.response.body === 'string' ? matched.response.body : JSON.stringify(matched.response.body))
              : undefined;
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.fulfillRequest', {
              requestId: params.requestId,
              responseCode: matched.response.status || 200,
              responseHeaders: Object.entries(matched.response.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
              body,
            });
          } else {
            // Continue without modification
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.continueRequest', {
              requestId: params.requestId,
            });
          }
        } else {
          // No match, continue
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.continueRequest', {
            requestId: params.requestId,
          });
        }
      } catch (err) {
        console.error('[network] Route handler error:', err);
      }
    });
  }

  activeRoutes.get(tab.id).set(pattern, {
    response: command.response,
    abort: command.abort,
  });

  // Collect all patterns for this tab
  const allPatterns = Array.from(activeRoutes.get(tab.id).keys()).map(p => ({
    urlPattern: p,
  }));

  // Enable Fetch with all current patterns
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
    patterns: allPatterns,
  });

  return { id: command.id, success: true, data: { routed: pattern } };
}

export async function handleUnroute(command) {
  const tab = await getActiveTab();
  const pattern = command.url;
  const routes = activeRoutes.get(tab.id);

  if (!routes) {
    return { id: command.id, success: true, data: { unrouted: pattern ?? 'all' } };
  }

  if (pattern) {
    routes.delete(pattern);
  } else {
    routes.clear();
  }

  if (routes.size === 0) {
    activeRoutes.delete(tab.id);
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.disable');
    } catch {
      // May not be attached
    }
  } else {
    // Re-enable with remaining patterns
    const allPatterns = Array.from(routes.keys()).map(p => ({ urlPattern: p }));
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
      patterns: allPatterns,
    });
  }

  return { id: command.id, success: true, data: { unrouted: pattern ?? 'all' } };
}

// --- HAR Recording ---

export async function handleHarStart(command) {
  const tab = await getActiveTab();

  // Ensure network tracking is on
  if (!trackedRequests.has(tab.id)) {
    await ensureDebugger(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
    startTracking(tab.id);
  }

  // Clear previous requests and start fresh
  const state = trackedRequests.get(tab.id);
  if (state) state.requests = [];

  harRecording.set(tab.id, { startTime: Date.now() });

  return { id: command.id, success: true, data: { started: true } };
}

export async function handleHarStop(command) {
  const tab = await getActiveTab();
  const state = trackedRequests.get(tab.id);
  const harState = harRecording.get(tab.id);

  const requests = state ? state.requests : [];
  const requestCount = requests.length;

  // Build simplified HAR-like entries
  const entries = requests.map(r => ({
    startedDateTime: new Date(r.timestamp * 1000).toISOString(),
    request: {
      method: r.method,
      url: r.url,
      headers: r.headers ? Object.entries(r.headers).map(([name, value]) => ({ name, value })) : [],
    },
    response: {
      status: r.status || 0,
      statusText: r.statusText || '',
      headers: r.responseHeaders ? Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })) : [],
      content: {
        size: r.responseSize || 0,
        mimeType: r.mimeType || '',
      },
    },
  }));

  harRecording.delete(tab.id);

  return {
    id: command.id,
    success: true,
    data: {
      path: command.path,
      requestCount,
      log: {
        version: '1.2',
        entries,
      },
    },
  };
}
