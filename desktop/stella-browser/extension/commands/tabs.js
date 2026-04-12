/**
 * Tab management command handlers.
 *
 * Stella owns one dedicated Chrome window and tab group. Within that shared
 * window, each command owner gets its own logical tab set and active tab so
 * concurrent agents do not fight over whichever Chrome tab happens to be
 * focused.
 */

import { clearCdpEvents } from '../lib/debugger.js';
import { clearOwnerRefMaps, clearTabRefMap } from '../lib/selector.js';

let agentWindowId = null;
let stellaGroupId = null;
let parkingTabId = null;
let ownerTabState = {};
let stateLoaded = false;
let ensureAgentWindowPromise = null;
let staleTabCleanupPromise = null;

const STELLA_GROUP_TITLE = 'Stella';
const STELLA_GROUP_COLOR = 'pink';
const STELLA_PARKING_URL = 'about:blank';
const DEFAULT_OWNER_ID = 'default';
const STALE_TAB_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Apply title and color to a tab group.
 */
async function updateGroupStyle(groupId) {
  try {
    await chrome.tabGroups.update(groupId, {
      title: STELLA_GROUP_TITLE,
      color: STELLA_GROUP_COLOR,
    });
  } catch {}
}

function normalizeOwnerId(ownerId) {
  if (typeof ownerId !== 'string') return DEFAULT_OWNER_ID;
  const trimmed = ownerId.trim();
  return trimmed || DEFAULT_OWNER_ID;
}

function normalizeTabActivity(rawActivity, tabIds) {
  const source = rawActivity && typeof rawActivity === 'object' ? rawActivity : {};
  const now = Date.now();
  const next = {};

  for (const tabId of tabIds) {
    const key = String(tabId);
    const timestamp = Number(source[key]);
    next[key] = Number.isFinite(timestamp) ? timestamp : now;
  }

  return next;
}

function touchOwnerTab(ownerId, tabId, timestamp = Date.now()) {
  if (!Number.isInteger(tabId)) return;
  const state = getOwnerState(ownerId);
  state.lastTouchedAtByTabId[String(tabId)] = timestamp;
}

export function getCommandOwnerId(command) {
  return normalizeOwnerId(command?.ownerId);
}

function sanitizeOwnerTabState(raw) {
  if (!raw || typeof raw !== 'object') return {};

  const next = {};
  for (const [ownerId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;

    const tabIds = Array.isArray(value.tabIds)
      ? value.tabIds.filter((tabId) => Number.isInteger(tabId))
      : [];
    const activeTabId = Number.isInteger(value.activeTabId) ? value.activeTabId : null;
    const lastTouchedAtByTabId = normalizeTabActivity(value.lastTouchedAtByTabId, tabIds);

    if (tabIds.length === 0 && activeTabId == null) {
      continue;
    }

    next[normalizeOwnerId(ownerId)] = {
      tabIds,
      activeTabId,
      lastTouchedAtByTabId,
    };
  }

  return next;
}

function getOwnerState(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  if (!ownerTabState[normalized]) {
    ownerTabState[normalized] = {
      tabIds: [],
      activeTabId: null,
      lastTouchedAtByTabId: {},
    };
  }
  return ownerTabState[normalized];
}

function deleteOwnerState(ownerId) {
  delete ownerTabState[normalizeOwnerId(ownerId)];
}

function getOwnedTabIds() {
  const tabIds = new Set();
  for (const state of Object.values(ownerTabState)) {
    for (const tabId of state.tabIds || []) {
      tabIds.add(tabId);
    }
  }
  return tabIds;
}

function resetAgentState() {
  agentWindowId = null;
  stellaGroupId = null;
  parkingTabId = null;
  ownerTabState = {};
  clearOwnerRefMaps();
}

/**
 * Load persisted window/group/owner state from session storage.
 */
async function loadState() {
  if (stateLoaded) return;
  try {
    const data = await chrome.storage.session.get([
      'agentWindowId',
      'stellaGroupId',
      'parkingTabId',
      'ownerTabState',
    ]);
    if (data.agentWindowId != null) agentWindowId = data.agentWindowId;
    if (data.stellaGroupId != null) stellaGroupId = data.stellaGroupId;
    if (data.parkingTabId != null) parkingTabId = data.parkingTabId;
    ownerTabState = sanitizeOwnerTabState(data.ownerTabState);
  } catch {
    ownerTabState = {};
  }
  stateLoaded = true;
}

/**
 * Persist current window/group/owner state to session storage.
 */
async function saveState() {
  try {
    await chrome.storage.session.set({
      agentWindowId,
      stellaGroupId,
      parkingTabId,
      ownerTabState,
    });
  } catch {}
}

async function ensureParkingTab() {
  if (agentWindowId == null || stellaGroupId == null) {
    return null;
  }

  const existingParkingTab = await getTabIfValid(parkingTabId);
  if (existingParkingTab) {
    if (existingParkingTab.groupId !== stellaGroupId) {
      try {
        await chrome.tabs.group({ tabIds: [existingParkingTab.id], groupId: stellaGroupId });
      } catch {}
    }
    return existingParkingTab;
  }

  const tab = await chrome.tabs.create({
    url: STELLA_PARKING_URL,
    active: false,
    windowId: agentWindowId,
  });
  parkingTabId = tab.id;
  await addToStellaGroup(tab.id);
  await saveState();
  return tab;
}

async function ensureStellaGroupInWindow(windowId) {
  let tabs = await chrome.tabs.query({ windowId });
  if (tabs.length === 0) {
    const parkingTab = await chrome.tabs.create({
      url: STELLA_PARKING_URL,
      active: false,
      windowId,
    });
    tabs = [parkingTab];
  }

  const groupId = await chrome.tabs.group({
    tabIds: tabs.map((tab) => tab.id),
    createProperties: { windowId },
  });

  agentWindowId = windowId;
  stellaGroupId = groupId;
  const ownedTabIds = getOwnedTabIds();
  parkingTabId =
    tabs.find((tab) => tab.url === STELLA_PARKING_URL && !ownedTabIds.has(tab.id))?.id ?? null;
  await updateGroupStyle(groupId);
  await saveState();
  return groupId;
}

/**
 * Search all tab groups for an existing "Stella" group and recover window ID.
 */
async function recoverExistingGroup() {
  try {
    const groups = await chrome.tabGroups.query({ title: STELLA_GROUP_TITLE });
    if (groups.length > 0) {
      const groupEntries = [];
      for (const group of groups) {
        try {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          if (tabs.length > 0) {
            groupEntries.push({ group, tabs });
          }
        } catch {}
      }

      if (groupEntries.length === 0) {
        return false;
      }

      groupEntries.sort((left, right) => right.tabs.length - left.tabs.length);
      const [primary, ...duplicates] = groupEntries;
      stellaGroupId = primary.group.id;
      agentWindowId = primary.group.windowId;

      for (const entry of duplicates) {
        try {
          await chrome.tabs.group({
            tabIds: entry.tabs.map((tab) => tab.id),
            groupId: stellaGroupId,
          });
        } catch {}
      }

      const ownedTabIds = getOwnedTabIds();
      parkingTabId =
        primary.tabs.find(
          (tab) => tab.url === STELLA_PARKING_URL && !ownedTabIds.has(tab.id),
        )?.id ?? parkingTabId;
      await updateGroupStyle(stellaGroupId);
      await saveState();
      return true;
    }
  } catch {}
  return false;
}

/**
 * Ensure Stella has a dedicated window with a Stella tab group.
 */
async function ensureAgentWindowInternal() {
  await loadState();

  if (agentWindowId != null) {
    try {
      await chrome.windows.get(agentWindowId);
    } catch {
      resetAgentState();
    }
  }

  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  const currentParkingTab = await getTabIfValid(parkingTabId);
  if (!currentParkingTab || (stellaGroupId != null && currentParkingTab.groupId !== stellaGroupId)) {
    parkingTabId = null;
  }

  if (agentWindowId == null || stellaGroupId == null) {
    if (await recoverExistingGroup()) {
      try {
        await chrome.windows.get(agentWindowId);
      } catch {
        resetAgentState();
      }
    }
  }

  if (agentWindowId != null && stellaGroupId == null) {
    try {
      await ensureStellaGroupInWindow(agentWindowId);
    } catch {
      resetAgentState();
    }
  }

  if (agentWindowId != null) {
    await updateGroupStyle(stellaGroupId);
    await ensureParkingTab();
    await saveState();
    return agentWindowId;
  }

  const win = await chrome.windows.create({
    url: STELLA_PARKING_URL,
    focused: true,
  });
  agentWindowId = win.id;

  const tabs = await chrome.tabs.query({ windowId: agentWindowId });
  if (tabs.length > 0) {
    const groupId = await chrome.tabs.group({
      tabIds: tabs.map((tab) => tab.id),
      createProperties: { windowId: agentWindowId },
    });
    await updateGroupStyle(groupId);
    stellaGroupId = groupId;
    parkingTabId = tabs[0]?.id ?? null;
  }

  await ensureParkingTab();
  await saveState();
  return agentWindowId;
}

async function ensureAgentWindow() {
  if (ensureAgentWindowPromise) {
    return ensureAgentWindowPromise;
  }

  ensureAgentWindowPromise = ensureAgentWindowInternal().finally(() => {
    ensureAgentWindowPromise = null;
  });
  return ensureAgentWindowPromise;
}

/**
 * Add a tab to the Stella group.
 */
async function addToStellaGroup(tabId) {
  await loadState();

  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  if (stellaGroupId == null) {
    await recoverExistingGroup();
  }

  if (stellaGroupId != null) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: stellaGroupId });
  } else {
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: agentWindowId },
    });
    await updateGroupStyle(groupId);
    stellaGroupId = groupId;
    await saveState();
  }
}

async function getTabIfValid(tabId) {
  if (!Number.isInteger(tabId)) return null;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (agentWindowId != null && tab.windowId !== agentWindowId) {
      return null;
    }
    return tab;
  } catch {
    return null;
  }
}

async function pruneOwnerTabs(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  const state = ownerTabState[normalized];
  if (!state) return [];

  let changed = false;
  const tabs = [];
  const nextTabIds = [];

  for (const tabId of state.tabIds) {
    const tab = await getTabIfValid(tabId);
    if (!tab) {
      clearTabRefMap(normalized, tabId);
      changed = true;
      continue;
    }
    nextTabIds.push(tabId);
    tabs.push(tab);
  }

  state.tabIds = nextTabIds;
  const nextActivity = normalizeTabActivity(state.lastTouchedAtByTabId, nextTabIds);
  if (JSON.stringify(nextActivity) !== JSON.stringify(state.lastTouchedAtByTabId ?? {})) {
    changed = true;
  }
  state.lastTouchedAtByTabId = nextActivity;
  if (!nextTabIds.includes(state.activeTabId)) {
    state.activeTabId = nextTabIds[0] ?? null;
    changed = true;
  }

  if (state.tabIds.length === 0) {
    deleteOwnerState(normalized);
    clearOwnerRefMaps(normalized);
    changed = true;
  }

  if (changed) {
    await saveState();
  }

  return tabs;
}

async function createOwnerTab(ownerId, url = 'about:blank') {
  const windowId = await ensureAgentWindow();
  const tab = await chrome.tabs.create({
    url,
    active: false,
    windowId,
  });
  await addToStellaGroup(tab.id);

  const state = getOwnerState(ownerId);
  state.tabIds.push(tab.id);
  state.activeTabId = tab.id;
  touchOwnerTab(ownerId, tab.id);
  await saveState();
  return tab;
}

async function getOwnerTabs(ownerId, { ensureWindow = false } = {}) {
  await loadState();
  if (ensureWindow) {
    await ensureAgentWindow();
  }
  await cleanupStaleTabs();
  return pruneOwnerTabs(ownerId);
}

/**
 * Get the currently active logical tab for the command owner.
 */
export async function getActiveTab(command) {
  const ownerId = getCommandOwnerId(command);
  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const state = getOwnerState(ownerId);

  if (state.activeTabId != null) {
    const activeTab = tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab) {
      if (stellaGroupId != null && activeTab.groupId !== stellaGroupId) {
        try {
          await chrome.tabs.group({ tabIds: [activeTab.id], groupId: stellaGroupId });
        } catch {}
      }
      touchOwnerTab(ownerId, activeTab.id);
      await saveState();
      return activeTab;
    }
  }

  if (tabs.length > 0) {
    state.activeTabId = tabs[0].id;
    touchOwnerTab(ownerId, tabs[0].id);
    await saveState();
    return tabs[0];
  }

  return createOwnerTab(ownerId);
}

async function cleanupStaleTabsInternal({ now = Date.now() } = {}) {
  await loadState();

  if (agentWindowId != null && stellaGroupId != null) {
    try {
      await chrome.windows.get(agentWindowId);
      await chrome.tabGroups.get(stellaGroupId);
      await ensureParkingTab();
    } catch {}
  }

  const staleCutoff = now - STALE_TAB_TIMEOUT_MS;
  const staleTabIds = [];
  let changed = false;

  for (const [ownerId, state] of Object.entries(ownerTabState)) {
    const nextTabIds = [];

    for (const tabId of state.tabIds) {
      const tab = await getTabIfValid(tabId);
      if (!tab) {
        clearTabRefMap(ownerId, tabId);
        clearCdpEvents(tabId);
        changed = true;
        continue;
      }

      const lastTouchedAt = Number(state.lastTouchedAtByTabId?.[String(tabId)] ?? now);
      if (tabId !== parkingTabId && lastTouchedAt <= staleCutoff) {
        staleTabIds.push({ ownerId, tabId });
        changed = true;
        continue;
      }

      nextTabIds.push(tabId);
    }

    state.tabIds = nextTabIds;
    const nextActivity = normalizeTabActivity(state.lastTouchedAtByTabId, nextTabIds);
    if (JSON.stringify(nextActivity) !== JSON.stringify(state.lastTouchedAtByTabId ?? {})) {
      changed = true;
    }
    state.lastTouchedAtByTabId = nextActivity;
    if (!nextTabIds.includes(state.activeTabId)) {
      state.activeTabId = nextTabIds[0] ?? null;
      changed = true;
    }

    if (state.tabIds.length === 0) {
      deleteOwnerState(ownerId);
      clearOwnerRefMaps(ownerId);
      changed = true;
    }
  }

  if (staleTabIds.length > 0) {
    for (const { ownerId, tabId } of staleTabIds) {
      clearTabRefMap(ownerId, tabId);
      clearCdpEvents(tabId);
    }

    try {
      await chrome.tabs.remove(staleTabIds.map(({ tabId }) => tabId));
    } catch {}
  }

  if (changed) {
    await saveState();
  }

  return { closed: staleTabIds.length };
}

export async function cleanupStaleTabs(options) {
  if (staleTabCleanupPromise) {
    return staleTabCleanupPromise;
  }

  staleTabCleanupPromise = cleanupStaleTabsInternal(options).finally(() => {
    staleTabCleanupPromise = null;
  });
  return staleTabCleanupPromise;
}

/**
 * Clean up stale unnamed tab groups left over from previous sessions.
 */
export async function cleanupStaleGroups() {
  try {
    const allGroups = await chrome.tabGroups.query({});
    for (const group of allGroups) {
      if (!group.title || group.title === '') {
        try {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          if (tabs.length > 0) {
            await chrome.tabs.ungroup(tabs.map((tab) => tab.id));
          }
        } catch {}
      }
    }
  } catch {}
}

async function validateAgentWindowAfterClose() {
  if (agentWindowId == null) return;

  try {
    await chrome.windows.get(agentWindowId);
  } catch {
    resetAgentState();
    await saveState();
  }
}

/**
 * Close all tabs owned by a specific command owner.
 */
export async function closeOwnerTabs(commandOrOwnerId) {
  const ownerId =
    typeof commandOrOwnerId === 'string'
      ? normalizeOwnerId(commandOrOwnerId)
      : getCommandOwnerId(commandOrOwnerId);

  const tabs = await getOwnerTabs(ownerId);
  if (tabs.length === 0) {
    deleteOwnerState(ownerId);
    clearOwnerRefMaps(ownerId);
    await saveState();
    return { closed: 0 };
  }

  await ensureAgentWindow();

  for (const tab of tabs) {
    clearTabRefMap(ownerId, tab.id);
    clearCdpEvents(tab.id);
  }

  try {
    await chrome.tabs.remove(tabs.map((tab) => tab.id));
  } catch {}

  deleteOwnerState(ownerId);
  clearOwnerRefMaps(ownerId);
  await saveState();
  await validateAgentWindowAfterClose();
  return { closed: tabs.length };
}

/**
 * Close the shared agent window and reset all owner state.
 */
export async function closeAgentWindow() {
  if (agentWindowId != null) {
    try {
      await chrome.windows.remove(agentWindowId);
    } catch {}
  }

  resetAgentState();
  await saveState();
}

export async function handleTabNew(command) {
  const ownerId = getCommandOwnerId(command);
  const tab = await createOwnerTab(ownerId, command.url || 'about:blank');

  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });

  return {
    id: command.id,
    success: true,
    data: { index: tabs.findIndex((item) => item.id === tab.id), total: tabs.length },
  };
}

export async function handleTabList(command) {
  const ownerId = getCommandOwnerId(command);
  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const state = getOwnerState(ownerId);
  const activeIndex = tabs.findIndex((tab) => tab.id === state.activeTabId);

  if (state.activeTabId != null) {
    touchOwnerTab(ownerId, state.activeTabId);
    await saveState();
  }

  return {
    id: command.id,
    success: true,
    data: {
      tabs: tabs.map((tab, index) => ({
        index,
        url: tab.url || '',
        title: tab.title || '',
        active: tab.id === state.activeTabId,
      })),
      active: activeIndex,
    },
  };
}

export async function handleTabSwitch(command) {
  const ownerId = getCommandOwnerId(command);
  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const index = command.index ?? 0;

  if (index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  const tab = tabs[index];
  const state = getOwnerState(ownerId);
  state.activeTabId = tab.id;
  touchOwnerTab(ownerId, tab.id);
  await saveState();

  return {
    id: command.id,
    success: true,
    data: { index, url: tab.url || '', title: tab.title || '' },
  };
}

export async function handleTabClose(command) {
  const ownerId = getCommandOwnerId(command);
  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const state = getOwnerState(ownerId);

  let index = command.index;
  if (index === undefined || index === null) {
    index = tabs.findIndex((tab) => tab.id === state.activeTabId);
  }

  if (index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  const tab = tabs[index];
  clearTabRefMap(ownerId, tab.id);
  clearCdpEvents(tab.id);

  if (state.tabIds.length === 1) {
    await ensureAgentWindow();
  }

  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  state.tabIds = state.tabIds.filter((tabId) => tabId !== tab.id);
  delete state.lastTouchedAtByTabId?.[String(tab.id)];
  state.activeTabId = state.tabIds[index] ?? state.tabIds[index - 1] ?? null;

  if (state.tabIds.length === 0) {
    deleteOwnerState(ownerId);
    clearOwnerRefMaps(ownerId);
  }

  await saveState();
  await validateAgentWindowAfterClose();

  return {
    id: command.id,
    success: true,
    data: {
      closed: index,
      remaining: state.tabIds?.length ?? 0,
    },
  };
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void (async () => {
    await loadState();

    let changed = false;
    for (const [ownerId, state] of Object.entries(ownerTabState)) {
      if (!state.tabIds.includes(tabId)) continue;

      state.tabIds = state.tabIds.filter((candidate) => candidate !== tabId);
      delete state.lastTouchedAtByTabId?.[String(tabId)];
      if (state.activeTabId === tabId) {
        state.activeTabId = state.tabIds[0] ?? null;
      }

      clearTabRefMap(ownerId, tabId);
      clearCdpEvents(tabId);

      if (state.tabIds.length === 0) {
        deleteOwnerState(ownerId);
        clearOwnerRefMaps(ownerId);
      }

      changed = true;
    }

    if (removeInfo.windowId === agentWindowId && removeInfo.isWindowClosing) {
      resetAgentState();
      changed = true;
    }

    if (changed) {
      await saveState();
    }
  })().catch(() => {});
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== agentWindowId) return;

  resetAgentState();
  void saveState();
});
