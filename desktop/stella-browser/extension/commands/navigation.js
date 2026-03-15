/**
 * Navigation command handlers.
 */
import { getActiveTab } from './tabs.js';
import { ensureDebugger, onCdpEvent, offCdpEvent } from '../lib/debugger.js';

const NETWORK_IDLE_MS = 500;

async function focusTabWindow(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
}

function waitForPageEvent(tabId, method, timeout = 30000) {
  return new Promise(async (resolve, reject) => {
    const listener = () => {
      clearTimeout(timer);
      offCdpEvent(tabId, method, listener);
      resolve();
    };

    const timer = setTimeout(() => {
      offCdpEvent(tabId, method, listener);
      reject(new Error('Navigation timeout after ' + timeout + 'ms'));
    }, timeout);

    try {
      await ensureDebugger(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      onCdpEvent(tabId, method, listener);
    } catch (error) {
      clearTimeout(timer);
      offCdpEvent(tabId, method, listener);
      reject(error);
    }
  });
}

function waitForNetworkIdle(tabId, timeout = 30000) {
  return new Promise(async (resolve, reject) => {
    const activeRequests = new Set();
    let navigationStarted = false;
    let loadFired = false;
    let idleTimer = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      offCdpEvent(tabId, 'Network.requestWillBeSent', onRequestStarted);
      offCdpEvent(tabId, 'Network.loadingFinished', onRequestFinished);
      offCdpEvent(tabId, 'Network.loadingFailed', onRequestFinished);
      offCdpEvent(tabId, 'Page.loadEventFired', onLoadFired);
    };

    const maybeResolve = () => {
      if (!navigationStarted || !loadFired || activeRequests.size > 0 || idleTimer) {
        return;
      }
      idleTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, NETWORK_IDLE_MS);
    };

    const onRequestStarted = (params) => {
      if (params.type === 'Document') {
        navigationStarted = true;
        activeRequests.clear();
      }
      if (!navigationStarted) {
        return;
      }
      activeRequests.add(params.requestId);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const onRequestFinished = (params) => {
      if (!navigationStarted) {
        return;
      }
      activeRequests.delete(params.requestId);
      maybeResolve();
    };

    const onLoadFired = () => {
      loadFired = true;
      maybeResolve();
    };

    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error('Navigation timeout after ' + timeout + 'ms'));
    }, timeout);

    try {
      await ensureDebugger(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
      onCdpEvent(tabId, 'Network.requestWillBeSent', onRequestStarted);
      onCdpEvent(tabId, 'Network.loadingFinished', onRequestFinished);
      onCdpEvent(tabId, 'Network.loadingFailed', onRequestFinished);
      onCdpEvent(tabId, 'Page.loadEventFired', onLoadFired);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function waitForNavigationState(tabId, waitUntil = 'load', timeout = 30000) {
  switch (waitUntil) {
    case 'domcontentloaded':
      return waitForPageEvent(tabId, 'Page.domContentEventFired', timeout);
    case 'networkidle':
      return waitForNetworkIdle(tabId, timeout);
    case 'load':
    default:
      return waitForPageEvent(tabId, 'Page.loadEventFired', timeout);
  }
}

export async function handleNavigate(command) {
  const tab = await getActiveTab();
  const url = command.url;

  if (!url) throw new Error('URL is required for navigate');

  await focusTabWindow(tab);

  const waitPromise =
    command.waitUntil === 'none'
      ? null
      : waitForNavigationState(tab.id, command.waitUntil ?? 'load', command.timeout || 30000);

  // Start navigation
  await chrome.tabs.update(tab.id, { url });

  if (waitPromise) {
    await waitPromise;
  }

  const updated = await chrome.tabs.get(tab.id);

  // Pre-warm debugger for subsequent commands (click, fill, eval, etc.)
  try { await ensureDebugger(updated.id); } catch {}

  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleBack(command) {
  const tab = await getActiveTab();
  await focusTabWindow(tab);
  const waitPromise = waitForNavigationState(tab.id, 'load', command.timeout || 30000);
  await chrome.tabs.goBack(tab.id);
  await waitPromise;
  const updated = await chrome.tabs.get(tab.id);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleForward(command) {
  const tab = await getActiveTab();
  await focusTabWindow(tab);
  const waitPromise = waitForNavigationState(tab.id, 'load', command.timeout || 30000);
  await chrome.tabs.goForward(tab.id);
  await waitPromise;
  const updated = await chrome.tabs.get(tab.id);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleReload(command) {
  const tab = await getActiveTab();
  await focusTabWindow(tab);
  const waitPromise = waitForNavigationState(tab.id, 'load', command.timeout || 30000);
  await chrome.tabs.reload(tab.id);
  await waitPromise;
  const updated = await chrome.tabs.get(tab.id);

  // Pre-warm debugger for subsequent commands
  try { await ensureDebugger(updated.id); } catch {}

  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleUrl(command) {
  const tab = await getActiveTab();
  return {
    id: command.id,
    success: true,
    data: { url: tab.url || '' },
  };
}

export async function handleTitle(command) {
  const tab = await getActiveTab();
  return {
    id: command.id,
    success: true,
    data: { title: tab.title || '' },
  };
}
