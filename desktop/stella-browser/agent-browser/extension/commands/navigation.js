/**
 * Navigation command handlers.
 */
import { getActiveTab } from './tabs.js';
import { ensureDebugger } from '../lib/debugger.js';

/**
 * Wait for a tab to finish loading.
 * @param {number} tabId
 * @param {number} [timeout=30000]
 * @returns {Promise<void>}
 */
function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timeout after ' + timeout + 'ms'));
    }, timeout);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function handleNavigate(command) {
  const tab = await getActiveTab();
  const url = command.url;

  if (!url) throw new Error('URL is required for navigate');

  // Start navigation
  await chrome.tabs.update(tab.id, { url });

  // Wait for load unless explicitly told not to
  if (command.waitUntil !== 'none') {
    await waitForLoad(tab.id, command.timeout || 30000);
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
  await chrome.tabs.goBack(tab.id);
  // Small delay for navigation to start
  await new Promise(r => setTimeout(r, 500));
  const updated = await chrome.tabs.get(tab.id);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleForward(command) {
  const tab = await getActiveTab();
  await chrome.tabs.goForward(tab.id);
  await new Promise(r => setTimeout(r, 500));
  const updated = await chrome.tabs.get(tab.id);
  return {
    id: command.id,
    success: true,
    data: { url: updated.url, title: updated.title },
  };
}

export async function handleReload(command) {
  const tab = await getActiveTab();
  await chrome.tabs.reload(tab.id);
  await waitForLoad(tab.id, command.timeout || 30000);
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
