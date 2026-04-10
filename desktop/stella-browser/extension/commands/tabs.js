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
let ownerTabState = {};
let stateLoaded = false;

const STELLA_GROUP_TITLE = 'Stella';
const STELLA_GROUP_COLOR = 'pink';
const DEFAULT_OWNER_ID = 'default';

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

    if (tabIds.length === 0 && activeTabId == null) {
      continue;
    }

    next[normalizeOwnerId(ownerId)] = {
      tabIds,
      activeTabId,
    };
  }

  return next;
}

function getOwnerState(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  if (!ownerTabState[normalized]) {
    ownerTabState[normalized] = { tabIds: [], activeTabId: null };
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
      'ownerTabState',
    ]);
    if (data.agentWindowId != null) agentWindowId = data.agentWindowId;
    if (data.stellaGroupId != null) stellaGroupId = data.stellaGroupId;
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
      ownerTabState,
    });
  } catch {}
}

/**
 * Search all tab groups for an existing "Stella" group and recover window ID.
 */
async function recoverExistingGroup() {
  try {
    const groups = await chrome.tabGroups.query({ title: STELLA_GROUP_TITLE });
    if (groups.length > 0) {
      stellaGroupId = groups[0].id;
      agentWindowId = groups[0].windowId;
      for (let i = 1; i < groups.length; i++) {
        try {
          const dupeGroupTabs = await chrome.tabs.query({ groupId: groups[i].id });
          if (dupeGroupTabs.length > 0) {
            await chrome.tabs.group({
              tabIds: dupeGroupTabs.map((tab) => tab.id),
              groupId: stellaGroupId,
            });
          }
        } catch {}
      }
      await saveState();
      return true;
    }
  } catch {}
  return false;
}

/**
 * Ensure Stella has a dedicated window with a Stella tab group.
 */
async function ensureAgentWindow() {
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

  if (agentWindowId == null || stellaGroupId == null) {
    if (await recoverExistingGroup()) {
      try {
        await chrome.windows.get(agentWindowId);
        return agentWindowId;
      } catch {
        resetAgentState();
      }
    }
  }

  if (agentWindowId != null) return agentWindowId;

  const win = await chrome.windows.create({
    url: 'about:blank',
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
  }

  await saveState();
  return agentWindowId;
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

async function claimUnownedTab(ownerId) {
  const windowId = await ensureAgentWindow();
  const ownedTabIds = getOwnedTabIds();
  const tabs = await chrome.tabs.query({ windowId });
  const unowned = tabs.find((tab) => !ownedTabIds.has(tab.id));

  if (!unowned) {
    return null;
  }

  const state = getOwnerState(ownerId);
  state.tabIds = [unowned.id];
  state.activeTabId = unowned.id;
  await addToStellaGroup(unowned.id);
  await saveState();
  return unowned;
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
  await saveState();
  return tab;
}

async function getOwnerTabs(ownerId, { ensureWindow = false } = {}) {
  await loadState();
  if (ensureWindow) {
    await ensureAgentWindow();
  }
  return pruneOwnerTabs(ownerId);
}

/**
 * Get the currently active logical tab for the command owner.
 */
export async function getActiveTab(command) {
  const ownerId = getCommandOwnerId(command);
  let tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const state = getOwnerState(ownerId);

  if (state.activeTabId != null) {
    const activeTab = tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab) {
      if (stellaGroupId != null && activeTab.groupId !== stellaGroupId) {
        try {
          await chrome.tabs.group({ tabIds: [activeTab.id], groupId: stellaGroupId });
        } catch {}
      }
      return activeTab;
    }
  }

  if (tabs.length > 0) {
    state.activeTabId = tabs[0].id;
    await saveState();
    return tabs[0];
  }

  const claimedTab = await claimUnownedTab(ownerId);
  if (claimedTab) {
    return claimedTab;
  }

  return createOwnerTab(ownerId);
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
  let tab = null;
  const existingTabs = await getOwnerTabs(ownerId, { ensureWindow: true });

  if (existingTabs.length === 0) {
    const claimedTab = await claimUnownedTab(ownerId);
    if (claimedTab) {
      if (command.url && command.url !== 'about:blank') {
        await chrome.tabs.update(claimedTab.id, { url: command.url });
        tab = await chrome.tabs.get(claimedTab.id);
      } else {
        tab = claimedTab;
      }
    }
  }

  if (!tab) {
    tab = await createOwnerTab(ownerId, command.url || 'about:blank');
  }

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

  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  state.tabIds = state.tabIds.filter((tabId) => tabId !== tab.id);
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
