/**
 * Tab management command handlers.
 *
 * Agent operates in a dedicated Chrome window with a "Stella" tab group.
 * The user's existing windows/tabs are never touched.
 *
 * IDs are persisted to chrome.storage.session so they survive service worker
 * restarts (common in MV3). On every use we also verify the IDs are still
 * valid and fall back to searching for an existing "Stella" group.
 *
 * NOTE: chrome.tabGroups.update() has a Chromium rendering bug where the
 * title/color is set internally but the tab strip UI doesn't repaint.
 * The style shows correctly after any manual interaction with the group.
 * See: https://github.com/brave/brave-browser/issues/53373
 */

// --- Agent Window State ---

let agentWindowId = null;
let stellaGroupId = null;
let stateLoaded = false;

const STELLA_GROUP_TITLE = 'Stella';
const STELLA_GROUP_COLOR = 'pink';

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

/**
 * Load persisted window/group IDs from session storage.
 */
async function loadState() {
  if (stateLoaded) return;
  try {
    const data = await chrome.storage.session.get(['agentWindowId', 'stellaGroupId']);
    if (data.agentWindowId != null) agentWindowId = data.agentWindowId;
    if (data.stellaGroupId != null) stellaGroupId = data.stellaGroupId;
  } catch {}
  stateLoaded = true;
}

/**
 * Persist current window/group IDs to session storage.
 */
async function saveState() {
  try {
    await chrome.storage.session.set({ agentWindowId, stellaGroupId });
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
      // Merge any duplicate Stella groups into the first one
      for (let i = 1; i < groups.length; i++) {
        try {
          const dupeGroupTabs = await chrome.tabs.query({ groupId: groups[i].id });
          if (dupeGroupTabs.length > 0) {
            await chrome.tabs.group({
              tabIds: dupeGroupTabs.map(t => t.id),
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
 * Ensure the agent has a dedicated window with a Stella tab group.
 * Creates lazily on first use. Recovers from service worker restarts.
 */
async function ensureAgentWindow() {
  await loadState();

  // Validate cached window ID
  if (agentWindowId != null) {
    try {
      await chrome.windows.get(agentWindowId);
    } catch {
      agentWindowId = null;
      stellaGroupId = null;
    }
  }

  // Validate cached group ID
  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  // If we lost the IDs, try to find an existing Stella group
  if (agentWindowId == null || stellaGroupId == null) {
    if (await recoverExistingGroup()) {
      try {
        await chrome.windows.get(agentWindowId);
        return agentWindowId;
      } catch {
        agentWindowId = null;
        stellaGroupId = null;
      }
    }
  }

  if (agentWindowId != null) return agentWindowId;

  // Create a new window with a blank tab
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: true,
  });
  agentWindowId = win.id;

  // Group the initial tab under "Stella"
  const tabs = await chrome.tabs.query({ windowId: agentWindowId });
  if (tabs.length > 0) {
    const groupId = await chrome.tabs.group({
      tabIds: tabs.map(t => t.id),
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
            await chrome.tabs.ungroup(tabs.map(t => t.id));
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Close the agent window and reset state.
 */
export async function closeAgentWindow() {
  if (agentWindowId != null) {
    try {
      await chrome.windows.remove(agentWindowId);
    } catch {}
    agentWindowId = null;
    stellaGroupId = null;
    await saveState();
  }
}

// --- Tab Operations (scoped to agent window) ---

/**
 * Get the currently active tab in the agent window.
 */
export async function getActiveTab() {
  const windowId = await ensureAgentWindow();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) throw new Error('No active tab found');

  // Ensure this tab is in the Stella group (prevents stray ungrouped tabs)
  if (stellaGroupId != null && tab.groupId !== stellaGroupId) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: stellaGroupId });
    } catch {}
  }

  return tab;
}

export async function handleTabNew(command) {
  const windowId = await ensureAgentWindow();
  const tab = await chrome.tabs.create({
    url: command.url || 'about:blank',
    active: true,
    windowId,
  });
  await addToStellaGroup(tab.id);

  const tabs = await chrome.tabs.query({ windowId });
  return {
    id: command.id,
    success: true,
    data: { index: tabs.findIndex(t => t.id === tab.id), total: tabs.length },
  };
}

export async function handleTabList(command) {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId });
  const activeIndex = tabs.findIndex(t => t.active);

  const tabList = tabs.map((tab, index) => ({
    index,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active,
  }));

  return {
    id: command.id,
    success: true,
    data: { tabs: tabList, active: activeIndex },
  };
}

export async function handleTabSwitch(command) {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId });
  const index = command.index ?? 0;

  if (index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  const tab = tabs[index];
  await chrome.tabs.update(tab.id, { active: true });

  return {
    id: command.id,
    success: true,
    data: { index, url: tab.url || '', title: tab.title || '' },
  };
}

export async function handleTabClose(command) {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId });

  let index = command.index;
  if (index === undefined || index === null) {
    index = tabs.findIndex(t => t.active);
  }

  if (index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  const tab = tabs[index];
  await chrome.tabs.remove(tab.id);

  const remaining = await chrome.tabs.query({ windowId });
  return {
    id: command.id,
    success: true,
    data: { closed: index, remaining: remaining.length },
  };
}
