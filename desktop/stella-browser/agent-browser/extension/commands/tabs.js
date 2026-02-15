/**
 * Tab management command handlers.
 *
 * Agent operates in a dedicated Chrome window with a "Stella" tab group.
 * The user's existing windows/tabs are never touched.
 */

// --- Agent Window State ---

let agentWindowId = null;
let stellaGroupId = null;

/**
 * Ensure the agent has a dedicated window with a Stella tab group.
 * Creates lazily on first use. If the window was closed by the user,
 * creates a new one.
 */
async function ensureAgentWindow() {
  // Check if the window still exists
  if (agentWindowId != null) {
    try {
      await chrome.windows.get(agentWindowId);
    } catch {
      // Window was closed — reset
      agentWindowId = null;
      stellaGroupId = null;
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
    await chrome.tabGroups.update(groupId, {
      title: 'Stella',
      color: 'purple',
    });
    stellaGroupId = groupId;
  }

  console.log('[tabs] Created agent window', agentWindowId, 'with Stella group', stellaGroupId);
  return agentWindowId;
}

/**
 * Add a tab to the Stella group. Creates the group if needed.
 */
async function addToStellaGroup(tabId) {
  // Verify the group still exists
  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  if (stellaGroupId != null) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: stellaGroupId });
  } else {
    // Recreate the group
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: agentWindowId },
    });
    await chrome.tabGroups.update(groupId, {
      title: 'Stella',
      color: 'purple',
    });
    stellaGroupId = groupId;
  }
}

/**
 * Close the agent window and reset state.
 */
export async function closeAgentWindow() {
  if (agentWindowId != null) {
    try {
      await chrome.windows.remove(agentWindowId);
    } catch {
      // Already closed
    }
    agentWindowId = null;
    stellaGroupId = null;
  }
}

// --- Tab Operations (scoped to agent window) ---

/**
 * Get the currently active tab in the agent window.
 * Creates the agent window if it doesn't exist yet.
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function getActiveTab() {
  const windowId = await ensureAgentWindow();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

/**
 * Get tab by index from all tabs in the agent window.
 * @param {number} index
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getTabByIndex(index) {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId });
  if (index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }
  return tabs[index];
}

/**
 * Get the active tab index among all tabs in the agent window.
 * @returns {Promise<number>}
 */
async function getActiveTabIndex() {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.findIndex(t => t.active);
}

export async function handleTabNew(command) {
  const windowId = await ensureAgentWindow();
  const tab = await chrome.tabs.create({
    url: command.url || 'about:blank',
    active: true,
    windowId,
  });

  // Add to Stella group
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
    data: { tabs: tabList, activeIndex },
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
