/**
 * Network command handlers: requests, responsebody, route, unroute, har_start, har_stop.
 * Uses chrome.debugger CDP domains: Network (tracking), Fetch (interception).
 */
import {
  ensureDebugger,
  holdDebugger,
  onCdpEvent,
  offCdpEvent,
  clearCdpEvents,
  releaseDebugger,
} from '../lib/debugger.js';
import { getActiveTab } from './tabs.js';

// Per-tab tracking state
const trackedRequests = new Map();  // tabId -> { requests: [], tracking: true }
const activeRoutes = new Map();     // tabId -> Map<pattern, { response?, abort? }>
const harRecording = new Map();     // tabId -> { startTime, bodyBytes, pending: Set<Promise> }

/**
 * Body capture budgets. A HAR is only useful for deriving an API client if it
 * carries the actual payloads, but response bodies live in the CDP buffer and
 * copying every one of them (bundles, images, fonts) would blow out memory for
 * no benefit. Capture is therefore limited to API-shaped requests and capped.
 */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on tracked exchanges per tab. A recording left running on a busy site
 * would otherwise grow without bound inside the service worker; past this point
 * new requests are dropped and the recording reports itself as truncated.
 */
const MAX_TRACKED_REQUESTS = 5000;

/**
 * CDP keeps response payloads in a per-target ring buffer and evicts the oldest
 * once it is full. The defaults are sized for DevTools being open on one page,
 * which is easily exceeded by a multi-page recording, so ask for a larger one.
 */
const NETWORK_ENABLE_PARAMS = {
  maxTotalBufferSize: 100 * 1024 * 1024,
  maxResourceBufferSize: 20 * 1024 * 1024,
};

/** Cap on WebSocket/EventSource frames kept per connection, and their size. */
const MAX_STREAM_FRAMES = 300;
const MAX_FRAME_BYTES = 32 * 1024;

/**
 * Attach to nested targets as they appear. Cross-origin iframes, workers and
 * service workers each run in their own CDP target, and traffic they originate
 * is invisible on the tab's own session -- an embedded player or checkout flow
 * would otherwise record as a single document request and nothing else.
 */
const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};

/**
 * Streaming manifests describe where the actual media lives, which is the part
 * a derived client needs; the segments themselves are enormous and useless to
 * capture.
 */
function isMediaManifest(request) {
  const mimeType = (request.mimeType || '').toLowerCase();
  if (
    mimeType.includes('mpegurl') ||
    mimeType.includes('dash+xml') ||
    mimeType.includes('vnd.apple.mpegurl')
  ) {
    return true;
  }
  const url = (request.url || '').toLowerCase().split('?')[0];
  return url.endsWith('.m3u8') || url.endsWith('.mpd');
}

/**
 * Whether a tracked request looks like an API call worth keeping a body for.
 * `type` is the CDP resource type, which is the reliable signal; the MIME check
 * catches JSON delivered under a resource type we did not anticipate.
 */
function isApiShapedRequest(request) {
  if (request.type === 'XHR' || request.type === 'Fetch') return true;
  const mimeType = (request.mimeType || '').toLowerCase();
  if (mimeType.includes('json') || mimeType.includes('graphql')) return true;
  return isMediaManifest(request);
}

/** Address a command at the session that owns a request, if it has one. */
function sessionTarget(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

/** Find a tracked request, scoped to its session so ids cannot collide. */
function findRequest(state, requestId, sessionId) {
  const scoped = sessionId ?? null;
  for (let index = state.requests.length - 1; index >= 0; index -= 1) {
    const request = state.requests[index];
    if (request.requestId === requestId && request.sessionId === scoped) return request;
  }
  return null;
}

/**
 * Turn on network tracking for a freshly attached target and keep attaching
 * downwards, since an iframe can host further cross-origin iframes.
 */
async function enableNetworkForSession(tabId, sessionId) {
  const target = sessionTarget(tabId, sessionId);
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', NETWORK_ENABLE_PARAMS);
  } catch {
    // Target may already be gone; the parent session keeps recording.
  }
  try {
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
  } catch {
    // Nested auto-attach is best effort.
  }
}

// --- Request Tracking ---

function startTracking(tabId) {
  if (trackedRequests.has(tabId)) return; // Already tracking

  trackedRequests.set(tabId, { requests: [], tracking: true });

  // Adopt cross-origin iframes, workers and service workers as they appear.
  onCdpEvent(tabId, 'Target.attachedToTarget', (params) => {
    if (!params?.sessionId) return;
    void enableNetworkForSession(tabId, params.sessionId);
  });

  onCdpEvent(tabId, 'Network.requestWillBeSent', (params, source) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const sessionId = source?.sessionId ?? null;

    // A redirect is reported as the *next* request's `redirectResponse` rather
    // than through responseReceived, so without this the hop that was recorded
    // a moment ago would be emitted with no status at all.
    if (params.redirectResponse) {
      const previous = findRequest(state, params.requestId, sessionId);
      if (previous && previous.status === null) {
        previous.status = params.redirectResponse.status;
        previous.statusText = params.redirectResponse.statusText ?? '';
        previous.responseHeaders = params.redirectResponse.headers ?? null;
        previous.mimeType = params.redirectResponse.mimeType ?? '';
      }
    }

    if (state.requests.length >= MAX_TRACKED_REQUESTS) {
      state.truncated = true;
      return;
    }

    state.requests.push({
      requestId: params.requestId,
      sessionId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      // CDP inlines postData only when it is small; past that it sets
      // hasPostData and the payload must be pulled separately at har_stop.
      postData: params.request.postData ?? null,
      hasPostData: Boolean(params.request.hasPostData),
      timestamp: params.timestamp,
      type: params.type,
      status: null,
      responseHeaders: null,
      responseBody: null,
      responseBodyBase64: false,
      responseBodyTruncated: false,
    });
  });

  onCdpEvent(tabId, 'Network.responseReceived', (params, source) => {
    const state = trackedRequests.get(tabId);
    if (!state) return;

    const req = findRequest(state, params.requestId, source?.sessionId ?? null);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.responseHeaders = params.response.headers;
      req.mimeType = params.response.mimeType;
      req.responseSize = params.response.encodedDataLength;
    }
  });

  // Response bodies must be read while they are still in the CDP buffer, which
  // a navigation clears -- deferring to har_stop loses them. Capture at
  // loadingFinished instead, and only while a HAR recording is actually open.
  onCdpEvent(tabId, 'Network.loadingFinished', (params, source) => {
    const harState = harRecording.get(tabId);
    if (!harState) return;

    const state = trackedRequests.get(tabId);
    if (!state) return;

    const sessionId = source?.sessionId ?? null;
    const req = findRequest(state, params.requestId, sessionId);
    if (!req || !isApiShapedRequest(req)) return;
    if (harState.bodyBytes >= MAX_TOTAL_BODY_BYTES) return;

    const target = sessionTarget(tabId, sessionId);
    const capture = (async () => {
      // Oversized post bodies (the GraphQL case that matters most) are not
      // inlined on requestWillBeSent and must be pulled while the request is
      // still buffered -- by har_stop it is usually gone.
      if (!req.postData && req.hasPostData) {
        try {
          const posted = await chrome.debugger.sendCommand(
            target,
            'Network.getRequestPostData',
            { requestId: params.requestId }
          );
          if (typeof posted?.postData === 'string') req.postData = posted.postData;
        } catch {
          // Payload already evicted; the entry is still worth keeping.
        }
      }

      try {
        const result = await chrome.debugger.sendCommand(
          target,
          'Network.getResponseBody',
          { requestId: params.requestId }
        );
        if (typeof result?.body !== 'string') return;

        let body = result.body;
        if (body.length > MAX_BODY_BYTES) {
          body = body.slice(0, MAX_BODY_BYTES);
          req.responseBodyTruncated = true;
        }
        req.responseBody = body;
        req.responseBodyBase64 = Boolean(result.base64Encoded);
        harState.bodyBytes += body.length;
      } catch {
        // The buffer may already be evicted, or the target detached. A missing
        // body degrades the derived client; it must not fail the recording.
      }
    })();

    harState.pending.add(capture);
    void capture.finally(() => harState.pending.delete(capture));
  });

  // --- Streaming transports ---
  // Sites that push data over a socket or an event stream carry their real API
  // there. Neither shows up as a request/response pair, so both are recorded as
  // frames hanging off a synthetic entry.

  const streamEntry = (state, requestId, sessionId, url, kind) => {
    let entry = findRequest(state, requestId, sessionId);
    if (entry) return entry;
    if (state.requests.length >= MAX_TRACKED_REQUESTS) {
      state.truncated = true;
      return null;
    }
    entry = {
      requestId,
      sessionId: sessionId ?? null,
      url,
      method: 'GET',
      headers: {},
      postData: null,
      hasPostData: false,
      timestamp: Date.now() / 1000,
      type: kind,
      status: 101,
      statusText: '',
      responseHeaders: null,
      responseBody: null,
      responseBodyBase64: false,
      responseBodyTruncated: false,
      frames: [],
    };
    state.requests.push(entry);
    return entry;
  };

  const pushFrame = (entry, direction, payload, extra = {}) => {
    if (!entry || !Array.isArray(entry.frames)) return;
    if (entry.frames.length >= MAX_STREAM_FRAMES) {
      entry.framesTruncated = true;
      return;
    }
    const text = typeof payload === 'string' ? payload : '';
    entry.frames.push({
      type: direction,
      time: Date.now() / 1000,
      data: text.length > MAX_FRAME_BYTES ? text.slice(0, MAX_FRAME_BYTES) : text,
      ...extra,
    });
  };

  onCdpEvent(tabId, 'Network.webSocketCreated', (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;
    streamEntry(state, params.requestId, source?.sessionId ?? null, params.url, 'WebSocket');
  });

  const onWebSocketFrame = (direction) => (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;
    const entry = streamEntry(
      state,
      params.requestId,
      source?.sessionId ?? null,
      '',
      'WebSocket',
    );
    pushFrame(entry, direction, params.response?.payloadData, {
      opcode: params.response?.opcode,
    });
  };
  onCdpEvent(tabId, 'Network.webSocketFrameSent', onWebSocketFrame('send'));
  onCdpEvent(tabId, 'Network.webSocketFrameReceived', onWebSocketFrame('receive'));

  onCdpEvent(tabId, 'Network.eventSourceMessageReceived', (params, source) => {
    if (!harRecording.has(tabId)) return;
    const state = trackedRequests.get(tabId);
    if (!state) return;
    // An EventSource is an ordinary request that never finishes, so its entry
    // usually already exists from requestWillBeSent.
    const entry = streamEntry(
      state,
      params.requestId,
      source?.sessionId ?? null,
      '',
      'EventSource',
    );
    if (entry && !Array.isArray(entry.frames)) entry.frames = [];
    pushFrame(entry, 'receive', params.data, {
      eventName: params.eventName,
      eventId: params.eventId,
    });
  });
}

async function ensureNetworkTracking(tabId) {
  if (!trackedRequests.has(tabId)) {
    await ensureDebugger(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', NETWORK_ENABLE_PARAMS);
    startTracking(tabId);
    // Adopt any target that already exists, and everything created later.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
    } catch {
      // Older Chrome without flat auto-attach: main-frame capture still works.
    }
  }
}

function findTrackedResponse(tabId, url) {
  const state = trackedRequests.get(tabId);
  if (!state) return null;

  for (let index = state.requests.length - 1; index >= 0; index--) {
    const request = state.requests[index];
    if (request.url.includes(url) && request.status != null) {
      return request;
    }
  }

  return null;
}

async function waitForTrackedResponse(tabId, url, timeout = 30000) {
  const existing = findTrackedResponse(tabId, url);
  if (existing) return existing;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offCdpEvent(tabId, 'Network.responseReceived', onResponse);
      reject(new Error(`Timed out waiting for response matching: ${url}`));
    }, timeout);

    const onResponse = (params) => {
      const request = findTrackedResponse(tabId, url);
      if (!request || request.requestId !== params.requestId) return;
      clearTimeout(timer);
      offCdpEvent(tabId, 'Network.responseReceived', onResponse);
      resolve(request);
    };

    onCdpEvent(tabId, 'Network.responseReceived', onResponse);
  });
}

export async function handleRequests(command) {
  const tab = await getActiveTab(command);

  if (command.clear) {
    trackedRequests.delete(tab.id);
    return { id: command.id, success: true, data: { cleared: true } };
  }

  // Start tracking if not already
  await ensureNetworkTracking(tab.id);

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
  const tab = await getActiveTab(command);
  if (!command.url) throw new Error('url is required for responsebody');

  await ensureNetworkTracking(tab.id);
  const request = await waitForTrackedResponse(tab.id, command.url, command.timeout);
  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    'Network.getResponseBody',
    { requestId: request.requestId }
  );

  let body = result.body;
  if (!result.base64Encoded) {
    try {
      body = JSON.parse(result.body);
    } catch {
      // Keep the plain text body when it is not JSON.
    }
  }

  return {
    id: command.id,
    success: true,
    data: {
      url: request.url,
      status: request.status,
      body,
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
  const tab = await getActiveTab(command);
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
  const tab = await getActiveTab(command);
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
  const tab = await getActiveTab(command);

  // Ensure network tracking is on, including auto-attach to child targets.
  await ensureNetworkTracking(tab.id);

  // Clear previous requests and start fresh
  const state = trackedRequests.get(tab.id);
  if (state) {
    state.requests = [];
    state.truncated = false;
  }

  harRecording.set(tab.id, {
    startTime: Date.now(),
    bodyBytes: 0,
    pending: new Set(),
  });

  // A recording receives CDP events without issuing commands, so without a
  // hold the idle timer would detach the debugger part-way through and end the
  // capture with no error anywhere.
  holdDebugger(tab.id);

  return { id: command.id, success: true, data: { started: true } };
}

/**
 * Pull a post body that CDP declined to inline on requestWillBeSent. Only
 * called for requests that advertised hasPostData, and best-effort: the entry
 * is still worth emitting without its payload.
 */
async function resolvePostData(tabId, request) {
  if (request.postData) return request.postData;
  if (!request.hasPostData) return null;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Network.getRequestPostData',
      { requestId: request.requestId }
    );
    return typeof result?.postData === 'string' ? result.postData : null;
  } catch {
    return null;
  }
}

export async function handleHarStop(command) {
  const tab = await getActiveTab(command);
  const state = trackedRequests.get(tab.id);
  const harState = harRecording.get(tab.id);

  // Body captures are started from CDP events, so the last few may still be in
  // flight when the caller stops the recording.
  if (harState && harState.pending.size > 0) {
    await Promise.allSettled(Array.from(harState.pending));
  }

  releaseDebugger(tab.id);

  const requests = state ? state.requests : [];
  const requestCount = requests.length;

  const entries = await Promise.all(requests.map(async (r) => {
    const postData = await resolvePostData(tab.id, r);

    // DevTools exports socket traffic as `_webSocketMessages`; event-stream
    // frames follow the same shape under their own key.
    const frames = Array.isArray(r.frames) && r.frames.length > 0
      ? {
          [r.type === 'EventSource' ? '_eventSourceMessages' : '_webSocketMessages']: r.frames,
          ...(r.framesTruncated ? { _framesTruncated: true } : {}),
        }
      : {};

    return {
      startedDateTime: new Date(r.timestamp * 1000).toISOString(),
      _resourceType: r.type,
      ...frames,
      request: {
        method: r.method,
        url: r.url,
        headers: r.headers ? Object.entries(r.headers).map(([name, value]) => ({ name, value })) : [],
        ...(postData
          ? {
              postData: {
                mimeType: r.headers?.['content-type'] || r.headers?.['Content-Type'] || '',
                text: postData,
              },
            }
          : {}),
      },
      response: {
        status: r.status || 0,
        statusText: r.statusText || '',
        headers: r.responseHeaders ? Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })) : [],
        content: {
          size: r.responseSize || 0,
          mimeType: r.mimeType || '',
          ...(r.responseBody !== null
            ? {
                text: r.responseBody,
                ...(r.responseBodyBase64 ? { encoding: 'base64' } : {}),
                ...(r.responseBodyTruncated ? { _truncated: true } : {}),
              }
            : {}),
        },
      },
    };
  }));

  const bodiesCaptured = entries.filter(e => typeof e.response.content.text === 'string').length;
  const truncated = Boolean(state?.truncated);

  harRecording.delete(tab.id);

  // Captured bodies can run to megabytes. They have been serialized into the
  // response above, so drop the copies rather than holding them in the service
  // worker until the tab closes.
  if (state) {
    for (const request of state.requests) {
      request.responseBody = null;
      request.postData = null;
    }
  }

  return {
    id: command.id,
    success: true,
    data: {
      path: command.path,
      requestCount,
      bodiesCaptured,
      // Distinguishes "nothing was recorded" from "the recording was lost",
      // which otherwise both surface as an empty entry list.
      recordingWasOpen: Boolean(harState),
      ...(truncated ? { truncated: true, trackedLimit: MAX_TRACKED_REQUESTS } : {}),
      log: {
        version: '1.2',
        entries,
      },
    },
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  trackedRequests.delete(tabId);
  activeRoutes.delete(tabId);
  harRecording.delete(tabId);
  releaseDebugger(tabId);
});
