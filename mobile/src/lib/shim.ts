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
  bootstrap: { localStorage: Record<string, string> },
): string {
  const bridgeUrlJson = JSON.stringify(bridgeUrl);
  const bootstrapJson = JSON.stringify(bootstrap);

  return `(function() {
  'use strict';

  // ── Tag document for mobile CSS overrides ────────────────────────────
  document.documentElement.setAttribute('data-platform', 'mobile');

  // ── Inject bootstrap localStorage state ────────────────────────────
  // Copies the allowlisted desktop session and preference keys into the
  // WebView before the React app initializes.
  var __bootstrap = ${bootstrapJson};
  if (__bootstrap && __bootstrap.localStorage) {
    try {
      var __k = Object.keys(__bootstrap.localStorage);
      for (var __i = 0; __i < __k.length; __i++) {
        localStorage.setItem(__k[__i], __bootstrap.localStorage[__k[__i]]);
      }
    } catch(e) {
      console.warn('[stella-bridge] Failed to inject bootstrap state:', e);
    }
  }

  var BRIDGE_URL = ${bridgeUrlJson};
  var ws = null;
  var wsReady = false;
  var wsQueue = [];
  var responseCallbacks = new Map();
  var subscriptions = new Map();

  var wsReconnectDelay = 1000;

  function postNativeMessage(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function toWebSocketUrl(httpUrl) {
    var url = new URL(httpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  function postBridgeJson(path, args) {
    return fetch(BRIDGE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: args }),
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() { return { error: 'Bridge error' }; }).then(function(err) {
          throw new Error(err.error || 'Bridge error');
        });
      }
      return res.json();
    });
  }

  function postBridgeVoid(path, args) {
    fetch(BRIDGE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: args }),
    }).catch(function() {});
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    return postBridgeJson('/bridge/ipc/' + encodeURIComponent(channel), args).then(function(data) {
      return data.result;
    });
  }

  function fire(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    postBridgeVoid('/bridge/ipc/' + encodeURIComponent(channel), args);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    ws = new WebSocket(toWebSocketUrl(BRIDGE_URL) + '/bridge/ws');

    ws.onopen = function() {
      wsReady = true;
      wsReconnectDelay = 1000;
      postNativeMessage({ type: 'connectionState', connected: true });
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

    ws.onclose = function() {
      wsReady = false;
      postNativeMessage({ type: 'connectionState', connected: false });
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
      morphStart: function() { return resolved({ ok: false }); },
      morphComplete: function() { return resolved({ ok: false }); },
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

    radial: { onShow: noopSub, onHide: noopSub, animDone: noop, onCursor: noopSub, onWindowBounds: noopSub },

    // ── Overlay system (no-ops) ─────────────────────────────────────────

    overlay: {
      setInteractive: noop, onModifierBlock: noopSub,
      onStartRegionCapture: noopSub, onEndRegionCapture: noopSub,
      onShowMini: noopSub, onHideMini: noopSub, onRestoreMini: noopSub,
      onShowVoice: noopSub, onHideVoice: noopSub, onDisplayChange: noopSub,
      onMorphForward: noopSub, onMorphReverse: noopSub, onMorphEnd: noopSub,       onMorphBounds: noopSub,
      onMorphState: noopSub,
      morphReady: noop, morphDone: noop,
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
      persistTranscript: function(p) { fire('voice:persistTranscript', p); },
      orchestratorChat: function(p) { return invoke('voice:orchestratorChat', p); },
      webSearch: function(p) { return invoke('voice:webSearch', p); },
      getRuntimeState: function() { return invoke('voice:getRuntimeState'); },
      onRuntimeState: function(cb) { return subscribe('voice:runtimeState', cb); },
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
      startPhoneAccessSession: function() { return invoke('phoneAccess:startSession'); },
      stopPhoneAccessSession: function() { return invoke('phoneAccess:stopSession'); },
      configurePiRuntime: function(c) { return invoke('host:configurePiRuntime', c); },
      setAuthState: function() { return resolved(); },
      setCloudSyncEnabled: function() { return resolved(); },
      onAuthCallback: noopSub,
      openFullDiskAccess: noop,
      getPermissionStatus: function() { return resolved({ accessibility: false, screen: false }); },
      openPermissionSettings: function() { return resolved(); },
      openExternal: function(url) {
        postNativeMessage({ type: 'openExternal', url: url });
      },
      showItemInFolder: noop,
      shellKillByPort: function() { return resolved(); },
      getLocalSyncMode: function() { return invoke('preferences:getSyncMode'); },
      setLocalSyncMode: function(m) { return invoke('preferences:setSyncMode', m); },
      getRadialTriggerKey: function() { return resolved('option'); },
      setRadialTriggerKey: function(k) { return resolved({ triggerKey: k }); },
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
    },

    // ── Onboarding ──────────────────────────────────────────────────────

    onboarding: {
      synthesizeCoreMemory: function(p) { return invoke('onboarding:synthesizeCoreMemory', p); },
    },

    // ── Discovery ────────────────────────────────────────────────────────

    discovery: {
      checkCoreMemoryExists: function() { return invoke('discovery:coreMemoryExists'); },
      checkKnowledgeExists: function() { return invoke('discovery:knowledgeExists'); },
      collectData: function(o) { return invoke('discovery:collectBrowserData', o); },
      detectPreferred: function() { return invoke('discovery:detectPreferredBrowser'); },
      listProfiles: function(b) { return invoke('discovery:listBrowserProfiles', b); },
      writeCoreMemory: function(c) { return invoke('discovery:writeCoreMemory', c); },
      writeKnowledge: function(p) { return invoke('discovery:writeKnowledge', p); },
      collectAllSignals: function(o) { return invoke('discovery:collectAllSignals', o); },
    },

    // ── Browser data ────────────────────────────────────────────────────

    browser: {
      onBridgeStatus: function(cb) { return subscribe('browser:bridgeStatus', cb); },
      fetchJson: function(url, init) { return invoke('browser:fetchJson', url, init); },
      fetchText: function(url, init) { return invoke('browser:fetchText', url, init); },
    },

    // ── Office preview ──────────────────────────────────────────────────

    officePreview: {
      list: function() { return invoke('officePreview:list'); },
      onUpdate: function(cb) { return subscribe('officePreview:update', cb); },
    },

    // ── Media ────────────────────────────────────────────────────────────

    media: {
      saveOutput: function(url, fn) { return invoke('media:saveOutput', url, fn); },
      getStellaMediaDir: function() { return invoke('media:getStellaMediaDir'); },
    },

    // ── Google Workspace ─────────────────────────────────────────────────

    googleWorkspace: {
      getAuthStatus: function() { return invoke('googleWorkspace:authStatus'); },
      connect: function() { return invoke('googleWorkspace:connect'); },
      disconnect: function() { return invoke('googleWorkspace:disconnect'); },
      onAuthRequired: function(cb) { return subscribe('googleWorkspace:authRequired', cb); },
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
      persistDiscoveryWelcome: function(p) { return invoke('localChat:persistDiscoveryWelcome', p); },
      listSyncMessages: function(p) { return invoke('localChat:listSyncMessages', p); },
      getSyncCheckpoint: function(p) { return invoke('localChat:getSyncCheckpoint', p); },
      setSyncCheckpoint: function(p) { return invoke('localChat:setSyncCheckpoint', p); },
      onUpdated: function(cb) { return subscribe('localChat:updated', cb); },
    },

    // ── Social sessions ─────────────────────────────────────────────────

    socialSessions: {
      create: function(p) { return invoke('socialSessions:create', p); },
      updateStatus: function(p) { return invoke('socialSessions:updateStatus', p); },
      queueTurn: function(p) { return invoke('socialSessions:queueTurn', p); },
      getStatus: function() { return invoke('socialSessions:getStatus'); },
    },
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
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      document.documentElement.toggleAttribute('data-sidebar-open');
    });
    document.body.appendChild(toggle);

    // Close sidebar when tapping outside it or selecting a nav item
    document.addEventListener('click', function(e) {
      if (!document.documentElement.hasAttribute('data-sidebar-open')) return;
      if (e.target.closest('.mobile-sidebar-toggle')) return;
      if (e.target.closest('.sidebar-nav-item') || !e.target.closest('.sidebar')) {
        setTimeout(function() {
          document.documentElement.removeAttribute('data-sidebar-open');
        }, 100);
      }
    });
  });

  console.log('[stella-bridge] Mobile bridge shim initialized');
})();
true;`;
}
