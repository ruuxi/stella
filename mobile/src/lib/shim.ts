/**
 * Generates the complete window.electronAPI shim script.
 *
 * Injected into the WebView via `injectedJavaScriptBeforeContentLoaded` so
 * that it runs synchronously BEFORE the desktop React app's JS executes.
 * The desktop frontend sees a fully functional electronAPI and doesn't know
 * it's running on mobile.
 *
 * Transport:
 *   • HTTP invoke/fire  → POST /bridge/ipc/:channel  (request-response / fire-and-forget)
 *   • WebSocket          → ws://.../bridge/ws          (real-time subscriptions)
 *
 * Desktop-only features (window chrome, screenshots, overlays, radial menu)
 * are stubbed as no-ops so the frontend never crashes.
 */
export function generateShimScript(
  bridgeUrl: string,
  token: string,
  desktopState?: Record<string, string>,
): string {
  const bridgeUrlJson = JSON.stringify(bridgeUrl);
  const tokenJson = JSON.stringify(token);
  const stateJson = desktopState ? JSON.stringify(desktopState) : "null";

  return `(function() {
  'use strict';

  // ── Tag document for mobile CSS overrides ────────────────────────────
  document.documentElement.setAttribute('data-platform', 'mobile');

  // ── Inject desktop localStorage state ──────────────────────────────
  // Copies the desktop's auth, onboarding, and preference state so the
  // React app sees the same session instead of starting fresh.
  var __ds = ${stateJson};
  if (__ds) {
    try {
      var __k = Object.keys(__ds);
      for (var __i = 0; __i < __k.length; __i++) {
        localStorage.setItem(__k[__i], __ds[__k[__i]]);
      }
    } catch(e) {
      console.warn('[stella-bridge] Failed to inject desktop state:', e);
    }
  }

  var BRIDGE_URL = ${bridgeUrlJson};
  var SESSION_TOKEN = ${tokenJson};
  var ws = null;
  var wsReady = false;
  var wsQueue = [];
  var responseCallbacks = new Map();
  var subscriptions = new Map();
  var callId = 0;

  var wsReconnectDelay = 1000;
  var wsAuthFailures = 0;

  // ── HTTP helpers ──────────────────────────────────────────────────────

  function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch(BRIDGE_URL + '/bridge/ipc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SESSION_TOKEN,
      },
      body: JSON.stringify({ args: args }),
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() { return { error: 'Bridge error' }; }).then(function(err) {
          throw new Error(err.error || 'Bridge error');
        });
      }
      return res.json();
    }).then(function(data) {
      return data.result;
    });
  }

  function fire(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    fetch(BRIDGE_URL + '/bridge/ipc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SESSION_TOKEN,
      },
      body: JSON.stringify({ args: args }),
    }).catch(function() {});
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    ws = new WebSocket(BRIDGE_URL.replace('http', 'ws') + '/bridge/ws?token=' + encodeURIComponent(SESSION_TOKEN));

    ws.onopen = function() {
      wsReady = true;
      wsReconnectDelay = 1000;
      wsAuthFailures = 0;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'connectionState', connected: true }));
      }
      while (wsQueue.length > 0) { ws.send(wsQueue.shift()); }
      for (var ch of subscriptions.keys()) {
        ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
      }
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'event' && msg.channel) {
          var listeners = subscriptions.get(msg.channel);
          if (listeners) {
            listeners.forEach(function(cb) {
              try { cb(msg.data); } catch(e) { console.error('[bridge] Listener error:', e); }
            });
          }
        }
        if (msg.type === 'response' && msg.id) {
          var cb = responseCallbacks.get(msg.id);
          if (cb) {
            responseCallbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error));
            else cb.resolve(msg.result);
          }
        }
      } catch(e) {}
    };

    ws.onclose = function(ev) {
      wsReady = false;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'connectionState', connected: false }));
      }
      if (ev.code === 4001) { wsAuthFailures++; }
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 10000);
      setTimeout(connectWs, wsReconnectDelay);
    };

    ws.onerror = function() { wsReady = false; };
  }

  function wsSend(msg) {
    var str = JSON.stringify(msg);
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) { ws.send(str); }
    else { wsQueue.push(str); connectWs(); }
  }

  function subscribe(channel, cb) {
    if (!subscriptions.has(channel)) {
      subscriptions.set(channel, new Set());
      wsSend({ type: 'subscribe', channel: channel });
    }
    subscriptions.get(channel).add(cb);
    return function() {
      var listeners = subscriptions.get(channel);
      if (listeners) {
        listeners.delete(cb);
        if (listeners.size === 0) {
          subscriptions.delete(channel);
          wsSend({ type: 'unsubscribe', channel: channel });
        }
      }
    };
  }

  // ── Stubs ─────────────────────────────────────────────────────────────

  function noop() {}
  function noopSub() { return noop; }
  function resolved(val) { return Promise.resolve(val); }

  // ── window.electronAPI ────────────────────────────────────────────────

  window.electronAPI = {
    platform: 'mobile',

    // ── Desktop window chrome (no-ops) ──────────────────────────────────

    window: {
      minimize: noop, maximize: noop, close: noop,
      isMaximized: function() { return resolved(false); },
      show: noop,
    },

    // ── Display ─────────────────────────────────────────────────────────

    display: {
      onUpdate: function(cb) { return subscribe('display:update', cb); },
    },

    // ── UI state ────────────────────────────────────────────────────────

    ui: {
      getState: function() { return invoke('ui:getState'); },
      setState: function(partial) { return invoke('ui:setState', partial); },
      onState: function(cb) { return subscribe('ui:state', cb); },
      setAppReady: function(ready) { fire('app:setReady', ready); },
      reload: noop,
      hardReset: function() { return invoke('app:hardResetLocalState'); },
    },

    // ── Screen capture (mostly no-ops on mobile) ────────────────────────

    capture: {
      getContext: function() { return invoke('chatContext:get'); },
      onContext: function(cb) { return subscribe('chatContext:updated', cb); },
      ackContext: noop,
      screenshot: function() { return resolved(null); },
      removeScreenshot: noop, submitRegionSelection: noop, submitRegionClick: noop,
      getWindowCapture: function() { return resolved(null); },
      cancelRegion: noop,
      pageDataUrl: function() { return resolved(null); },
      onRegionReset: noopSub,
    },

    // ── Radial menu overlay (no-ops) ────────────────────────────────────

    radial: { onShow: noopSub, onHide: noopSub, animDone: noop, onCursor: noopSub },

    // ── Overlay system (no-ops) ─────────────────────────────────────────

    overlay: {
      setInteractive: noop, onModifierBlock: noopSub,
      onStartRegionCapture: noopSub, onEndRegionCapture: noopSub,
      onShowMini: noopSub, onHideMini: noopSub, onRestoreMini: noopSub,
      onShowVoice: noopSub, onHideVoice: noopSub, onDisplayChange: noopSub,
      onMorphForward: noopSub, onMorphReverse: noopSub, onMorphEnd: noopSub, onMorphState: noopSub,
      morphReady: noop, morphDone: noop,
      onShowAutoPanel: noopSub, onHideAutoPanel: noopSub, hideAutoPanel: noop,
      startAutoPanelStream: function() { return resolved({ ok: false }); },
      cancelAutoPanelStream: noop,
      onAutoPanelChunk: noopSub, onAutoPanelComplete: noopSub, onAutoPanelError: noopSub,
    },

    // ── Mini bridge ─────────────────────────────────────────────────────

    mini: {
      onVisibility: noopSub, onDismissPreview: noopSub,
      request: function(req) { return invoke('miniBridge:request', req); },
      onUpdate: function(cb) { return subscribe('miniBridge:update', cb); },
      onRequest: noopSub, respond: noop, ready: noop, pushUpdate: noop,
    },

    // ── Themes ──────────────────────────────────────────────────────────

    theme: {
      onChange: function(cb) {
        return subscribe('theme:change', function(data) { cb(null, data); });
      },
      broadcast: noop,
      listInstalled: function() { return invoke('theme:listInstalled'); },
    },

    // ── Voice ───────────────────────────────────────────────────────────

    voice: {
      submitTranscript: function(t) { fire('voice:transcript', t); },
      setShortcut: function() { return resolved({ ok: false, requestedShortcut: '', activeShortcut: '', error: 'Not supported on mobile' }); },
      onTranscript: function(cb) { return subscribe('voice:transcript', cb); },
      persistTranscript: function(p) { fire('voice:persistTranscript', p); },
      orchestratorChat: function(p) { return invoke('voice:orchestratorChat', p); },
      webSearch: function(p) { return invoke('voice:webSearch', p); },
      getRuntimeState: function() { return invoke('voice:getRuntimeState'); },
      onRuntimeState: function(cb) { return subscribe('voice:runtimeState', cb); },
      getWakeWordState: function() { return resolved({ enabled: false }); },
      onWakeWordState: noopSub,
      pushWakeWordAudio: noop,
      pushRuntimeState: function(s) { fire('voice:runtimeState', s); },
      setRtcShortcut: function() { return resolved({ ok: false, requestedShortcut: '', activeShortcut: '', error: 'Not supported on mobile' }); },
    },

    // ── Agent ───────────────────────────────────────────────────────────

    agent: {
      healthCheck: function() { return invoke('agent:healthCheck'); },
      getActiveRun: function() { return invoke('agent:getActiveRun'); },
      getAppSessionStartedAt: function() { return invoke('agent:getAppSessionStartedAt'); },
      startChat: function(p) { return invoke('agent:startChat', p); },
      cancelChat: function(runId) { fire('agent:cancelChat', runId); },
      resumeStream: function(p) { return invoke('agent:resume', p); },
      onStream: function(cb) { return subscribe('agent:event', cb); },
      onSelfModHmrState: function(cb) { return subscribe('agent:selfModHmrState', cb); },
      selfModRevert: function(fid, steps) { return invoke('selfmod:revert', { featureId: fid, steps: steps }); },
      getLastSelfModFeature: function() { return invoke('selfmod:lastFeature'); },
      listSelfModFeatures: function(limit) { return invoke('selfmod:recentFeatures', { limit: limit }); },
      triggerViteError: function() { return resolved({ ok: false }); },
      fixViteError: function() { return resolved({ ok: false }); },
    },

    // ── System ──────────────────────────────────────────────────────────

    system: {
      getDeviceId: function() { return invoke('device:getId'); },
      configurePiRuntime: function(c) { return invoke('host:configurePiRuntime', c); },
      setAuthState: function() { return resolved(); },
      setCloudSyncEnabled: function() { return resolved(); },
      onAuthCallback: noopSub,
      openFullDiskAccess: noop,
      openExternal: function(url) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'openExternal', url: url }));
        }
      },
      shellKillByPort: function() { return resolved(); },
      getLocalSyncMode: function() { return invoke('preferences:getSyncMode'); },
      setLocalSyncMode: function(m) { return invoke('preferences:setSyncMode', m); },
      syncLocalModelPreferences: function(p) { return invoke('preferences:syncLocalModelPreferences', p); },
      listLlmCredentials: function() { return invoke('llmCredentials:list'); },
      saveLlmCredential: function(p) { return invoke('llmCredentials:save', p); },
      deleteLlmCredential: function(p) { return invoke('llmCredentials:delete', p); },
      resetMessages: function() { return invoke('app:resetLocalMessages'); },
      onCredentialRequest: function(cb) {
        return subscribe('credential:request', function(data) { cb(null, data); });
      },
      submitCredential: function(p) { return invoke('credential:submit', p); },
      cancelCredential: function(p) { return invoke('credential:cancel', p); },
      getIdentityMap: function() { return invoke('identity:getMap'); },
      depseudonymize: function(t) { return invoke('identity:depseudonymize', t); },
    },

    // ── Browser data ────────────────────────────────────────────────────

    browser: {
      checkCoreMemoryExists: function() { return invoke('browserData:exists'); },
      collectData: function(o) { return invoke('browserData:collect', o); },
      detectPreferred: function() { return invoke('browserData:detectPreferredBrowser'); },
      listProfiles: function(b) { return invoke('browserData:listProfiles', b); },
      writeCoreMemory: function(c) { return invoke('browserData:writeCoreMemory', c); },
      collectAllSignals: function(o) { return invoke('signals:collectAll', o); },
    },

    // ── Projects ────────────────────────────────────────────────────────

    projects: {
      list: function() { return invoke('projects:list'); },
      pickDirectory: function() { return resolved({ canceled: true, projects: [] }); },
      start: function(id) { return invoke('projects:start', id); },
      stop: function(id) { return invoke('projects:stop', id); },
      onChanged: function(cb) { return subscribe('projects:changed', cb); },
    },

    // ── Schedule ────────────────────────────────────────────────────────

    schedule: {
      listCronJobs: function() { return invoke('schedule:listCronJobs'); },
      listHeartbeats: function() { return invoke('schedule:listHeartbeats'); },
      listConversationEvents: function(p) { return invoke('schedule:listConversationEvents', p); },
      getConversationEventCount: function(p) { return invoke('schedule:getConversationEventCount', p); },
      onUpdated: function(cb) { return subscribe('schedule:updated', cb); },
    },

    // ── Store / self-mod ────────────────────────────────────────────────

    store: {
      listSelfModFeatures: function(l) { return invoke('store:listLocalFeatures', { limit: l }); },
      listFeatureBatches: function(fid) { return invoke('store:listFeatureBatches', { featureId: fid }); },
      getReleaseDraft: function(p) { return invoke('store:createReleaseDraft', p); },
      publishRelease: function(p) { return invoke('store:publishRelease', p); },
      listPackages: function() { return invoke('store:listPackages'); },
      getPackage: function(pid) { return invoke('store:getPackage', { packageId: pid }); },
      listPackageReleases: function(pid) { return invoke('store:listReleases', { packageId: pid }); },
      getPackageRelease: function(p) { return invoke('store:getRelease', p); },
      listInstalledMods: function() { return invoke('store:listInstalledMods'); },
      installRelease: function(p) { return invoke('store:installRelease', p); },
      uninstallPackage: function(pid) { return invoke('store:uninstallMod', { packageId: pid }); },
    },

    // ── Local chat ──────────────────────────────────────────────────────

    localChat: {
      getOrCreateDefaultConversationId: function() { return invoke('localChat:getOrCreateDefaultConversationId'); },
      listEvents: function(p) { return invoke('localChat:listEvents', p); },
      getEventCount: function(p) { return invoke('localChat:getEventCount', p); },
      appendEvent: function(p) { return invoke('localChat:appendEvent', p); },
      listSyncMessages: function(p) { return invoke('localChat:listSyncMessages', p); },
      getSyncCheckpoint: function(p) { return invoke('localChat:getSyncCheckpoint', p); },
      setSyncCheckpoint: function(p) { return invoke('localChat:setSyncCheckpoint', p); },
      onUpdated: function(cb) { return subscribe('localChat:updated', cb); },
    },

    // ── Social sessions ─────────────────────────────────────────────────

    socialSessions: {
      getStatus: function() { return invoke('socialSessions:getStatus'); },
    },
  };

  // ── Token refresh ────────────────────────────────────────────────────
  // Called from the native side via injectJavaScript() when the JWT
  // is rotated. Updates the token for future HTTP calls and resets
  // WS auth-failure tracking so reconnects use the fresh credential.

  window.__stellaUpdateToken = function(newToken) {
    SESSION_TOKEN = newToken;
    wsAuthFailures = 0;
    // Force reconnect if the WS is not currently healthy — handles CLOSED,
    // CLOSING, and stale connections that stopped after auth failures.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try { ws.close(); } catch(e) {}
      }
      ws = null;
      connectWs();
    }
  };

  connectWs();

  // ── Mobile sidebar drawer ────────────────────────────────────────
  // Injects a hamburger toggle and backdrop into the desktop DOM so
  // the CSS in mobile.css can drive the slide-over drawer.
  document.addEventListener('DOMContentLoaded', function() {
    if (document.documentElement.getAttribute('data-platform') !== 'mobile') return;

    var toggle = document.createElement('button');
    toggle.className = 'mobile-sidebar-toggle';
    toggle.setAttribute('aria-label', 'Menu');
    toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>';
    toggle.addEventListener('click', function() {
      document.documentElement.toggleAttribute('data-sidebar-open');
    });

    var backdrop = document.createElement('div');
    backdrop.className = 'mobile-sidebar-backdrop';
    backdrop.addEventListener('click', function() {
      document.documentElement.removeAttribute('data-sidebar-open');
    });

    document.body.appendChild(toggle);
    document.body.appendChild(backdrop);

    // Auto-close sidebar when a nav item is tapped
    document.addEventListener('click', function(e) {
      if (e.target.closest('.sidebar-nav-item')) {
        setTimeout(function() {
          document.documentElement.removeAttribute('data-sidebar-open');
        }, 150);
      }
    });
  });

  console.log('[stella-bridge] Mobile bridge shim initialized');
})();
true;`;
}
