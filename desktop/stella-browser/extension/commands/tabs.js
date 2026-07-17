/**
 * Tab management command handlers.
 *
 * Stella reuses the user's normal Chrome window when possible. Each command
 * owner gets its own logical tab set and active tab so concurrent agents do
 * not fight over whichever Chrome tab happens to be focused.
 */

import { clearCdpEvents } from "../lib/debugger.js";
import { clearOwnerRefMaps, clearTabRefMap } from "../lib/selector.js";

let agentWindowId = null;
let stellaGroupId = null;
const createRecord = () => Object.create(null);
const UNSAFE_OWNER_IDS = new Set(["__proto__", "prototype", "constructor"]);
let ownerTabState = createRecord();
let ownerLeaseState = createRecord();
let stateLoaded = false;
let ensureAgentWindowPromise = null;
let ensureStellaGroupPromise = null;
let staleTabCleanupPromise = null;
const pendingTabAdoptions = new Map();

const STELLA_GROUP_TITLE = "Stella";
const STELLA_GROUP_COLOR = "pink";
const DEFAULT_OWNER_ID = "default";
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
  if (typeof ownerId !== "string") return DEFAULT_OWNER_ID;
  const trimmed = ownerId.trim();
  const normalized = trimmed || DEFAULT_OWNER_ID;
  if (UNSAFE_OWNER_IDS.has(normalized)) {
    throw new Error(`Unsafe ownerId: ${normalized}`);
  }
  return normalized;
}

function normalizeTabActivity(rawActivity, tabIds) {
  const source =
    rawActivity && typeof rawActivity === "object" ? rawActivity : {};
  const now = Date.now();
  const next = createRecord();

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
  if (!raw || typeof raw !== "object") return createRecord();

  const next = createRecord();
  for (const [ownerId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;

    let normalizedOwnerId;
    try {
      normalizedOwnerId = normalizeOwnerId(ownerId);
    } catch {
      continue;
    }

    const tabIds = Array.isArray(value.tabIds)
      ? value.tabIds.filter((tabId) => Number.isInteger(tabId))
      : [];
    const activeTabId = Number.isInteger(value.activeTabId)
      ? value.activeTabId
      : null;
    const lastTouchedAtByTabId = normalizeTabActivity(
      value.lastTouchedAtByTabId,
      tabIds,
    );

    if (tabIds.length === 0 && activeTabId == null) {
      continue;
    }

    next[normalizedOwnerId] = {
      tabIds,
      activeTabId,
      lastTouchedAtByTabId,
    };
  }

  return next;
}

function sanitizeOwnerLeaseState(raw) {
  if (!raw || typeof raw !== "object") return createRecord();
  const next = createRecord();
  for (const [ownerId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    try {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        typeof value.id === "string" &&
        value.id.trim() &&
        Number.isSafeInteger(value.issuedAt) &&
        value.issuedAt > 0
      ) {
        next[normalizedOwnerId] = {
          id: value.id.trim(),
          issuedAt: value.issuedAt,
        };
      }
    } catch {}
  }
  return next;
}

function getOwnerState(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  if (!Object.hasOwn(ownerTabState, normalized)) {
    ownerTabState[normalized] = {
      tabIds: [],
      activeTabId: null,
      lastTouchedAtByTabId: createRecord(),
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

function getTabOwnerId(tabId) {
  for (const [ownerId, state] of Object.entries(ownerTabState)) {
    if (state.tabIds?.includes(tabId)) return ownerId;
  }
  return null;
}

function getRequestedTabId(command) {
  if (command?.tabId === undefined || command?.tabId === null) return null;
  if (!Number.isInteger(command.tabId) || command.tabId <= 0) {
    throw new Error("tabId must be a positive integer");
  }
  return command.tabId;
}

function resetAgentState({ clearLeases = false } = {}) {
  agentWindowId = null;
  stellaGroupId = null;
  ownerTabState = createRecord();
  if (clearLeases) ownerLeaseState = createRecord();
  clearOwnerRefMaps();
}

/**
 * Load persisted window/group/owner state from session storage.
 */
async function loadState() {
  if (stateLoaded) return;
  try {
    const data = await chrome.storage.session.get([
      "agentWindowId",
      "stellaGroupId",
      "ownerTabState",
      "ownerLeaseState",
    ]);
    if (data.agentWindowId != null) agentWindowId = data.agentWindowId;
    if (data.stellaGroupId != null) stellaGroupId = data.stellaGroupId;
    ownerTabState = sanitizeOwnerTabState(data.ownerTabState);
    ownerLeaseState = sanitizeOwnerLeaseState(data.ownerLeaseState);
  } catch {
    ownerTabState = createRecord();
    ownerLeaseState = createRecord();
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
      ownerLeaseState,
    });
  } catch {}
}

export async function authorizeOwnerLease(command) {
  await loadState();
  const ownerId = getCommandOwnerId(command);
  const current = ownerLeaseState[ownerId];
  const leaseId = command?.ownerLeaseId;
  const issuedAt = command?.ownerLeaseIssuedAt;

  if (leaseId == null && issuedAt == null) {
    if (current) {
      throw new Error(
        `Browser protocol mismatch for owner "${ownerId}": this command has no owner lease. Update Stella and the Stella Browser extension to 1.2.6 or newer.`,
      );
    }
    return { ownerId, lease: null };
  }
  if (typeof leaseId !== "string" || !leaseId.trim()) {
    throw new Error("ownerLeaseId must be a non-empty string");
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new Error("ownerLeaseIssuedAt must be a positive integer");
  }

  const normalizedLease = { id: leaseId.trim(), issuedAt };
  if (current?.id === normalizedLease.id) {
    if (current.issuedAt !== normalizedLease.issuedAt) {
      throw new Error(`Browser owner lease timestamp changed for owner "${ownerId}"`);
    }
    return { ownerId, lease: normalizedLease };
  }
  if (current && normalizedLease.issuedAt <= current.issuedAt) {
    throw new Error(
      `Stale browser owner lease rejected for owner "${ownerId}"; a replacement kernel already owns this browser session.`,
    );
  }

  ownerLeaseState[ownerId] = normalizedLease;
  await saveState();
  return { ownerId, lease: normalizedLease };
}

export async function releaseOwnerLease(command) {
  await loadState();
  const ownerId = getCommandOwnerId(command);
  const current = ownerLeaseState[ownerId];
  if (
    current &&
    current.id === command?.ownerLeaseId &&
    current.issuedAt === command?.ownerLeaseIssuedAt
  ) {
    delete ownerLeaseState[ownerId];
    await saveState();
  }
}

export async function assertCurrentOwnerLease(command) {
  if (command?.ownerLeaseId == null && command?.ownerLeaseIssuedAt == null) return;
  await loadState();
  const ownerId = getCommandOwnerId(command);
  const current = ownerLeaseState[ownerId];
  if (
    !current ||
    current.id !== command.ownerLeaseId ||
    current.issuedAt !== command.ownerLeaseIssuedAt
  ) {
    throw new Error(
      `Stale browser owner lease rejected for owner "${ownerId}"; a replacement kernel already owns this browser session.`,
    );
  }
}

/**
 * Search all tab groups for an existing "Stella" group and recover window ID.
 */
async function recoverExistingGroup({ windowId } = {}) {
  try {
    const groups = await chrome.tabGroups.query({ title: STELLA_GROUP_TITLE });
    if (groups.length > 0) {
      const groupEntries = [];
      for (const group of groups) {
        if (windowId != null && group.windowId !== windowId) {
          continue;
        }
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

      await updateGroupStyle(stellaGroupId);
      await saveState();
      return true;
    }
  } catch {}
  return false;
}

async function getReusableWindowId() {
  try {
    const lastFocused = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (Number.isInteger(lastFocused?.id)) {
      return lastFocused.id;
    }
  } catch {}

  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const first = windows.find((window) => Number.isInteger(window.id));
    if (first) {
      return first.id;
    }
  } catch {}

  return null;
}

/**
 * Ensure Stella has a host window. Prefer an existing Stella group, then the
 * user's last-focused normal Chrome window. Creating a new Chrome window is a
 * fallback for when Chrome has no reusable normal window.
 */
async function ensureAgentWindowInternal() {
  await loadState();

  if (agentWindowId != null) {
    try {
      await chrome.windows.get(agentWindowId);
    } catch {
      agentWindowId = null;
      stellaGroupId = null;
    }
  }

  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  const hasOwnedTabs = getOwnedTabIds().size > 0;
  if (hasOwnedTabs && (agentWindowId == null || stellaGroupId == null)) {
    if (await recoverExistingGroup()) {
      try {
        await chrome.windows.get(agentWindowId);
      } catch {
        agentWindowId = null;
        stellaGroupId = null;
      }
    }
  }

  if (hasOwnedTabs && agentWindowId != null) {
    if (stellaGroupId != null) {
      await updateGroupStyle(stellaGroupId);
    }
    await saveState();
    return agentWindowId;
  }

  const reusableWindowId = await getReusableWindowId();
  if (reusableWindowId != null) {
    agentWindowId = reusableWindowId;
    await saveState();
    return agentWindowId;
  }

  return null;
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
async function addToStellaGroupInternal(tabId) {
  await loadState();

  if (stellaGroupId != null) {
    try {
      await chrome.tabGroups.get(stellaGroupId);
    } catch {
      stellaGroupId = null;
    }
  }

  if (stellaGroupId == null) {
    await recoverExistingGroup({ windowId: agentWindowId });
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

async function addToStellaGroup(tabId) {
  const previous = ensureStellaGroupPromise ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(() => addToStellaGroupInternal(tabId))
    .finally(() => {
      if (ensureStellaGroupPromise === run) {
        ensureStellaGroupPromise = null;
      }
    });
  ensureStellaGroupPromise = run;
  return ensureStellaGroupPromise;
}

async function getTabIfValid(tabId) {
  if (!Number.isInteger(tabId)) return null;

  try {
    return await chrome.tabs.get(tabId);
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
  const nextActivity = normalizeTabActivity(
    state.lastTouchedAtByTabId,
    nextTabIds,
  );
  if (
    JSON.stringify(nextActivity) !==
    JSON.stringify(state.lastTouchedAtByTabId ?? {})
  ) {
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

async function createOwnerTab(ownerId, url = "about:blank") {
  const windowId = await ensureAgentWindow();
  const tab =
    windowId == null
      ? await chrome.windows
          .create({ url, focused: true })
          .then(async (window) => {
            agentWindowId = window.id;
            const tabs = await chrome.tabs.query({ windowId: agentWindowId });
            return tabs[0];
          })
      : await chrome.tabs.create({
          url,
          active: false,
          windowId,
        });

  if (!tab?.id) {
    throw new Error("Failed to create browser tab");
  }

  await addToStellaGroup(tab.id);

  const state = getOwnerState(ownerId);
  state.tabIds.push(tab.id);
  state.activeTabId = tab.id;
  touchOwnerTab(ownerId, tab.id);
  await saveState();
  return tab;
}

async function awaitPendingTabAdoptions() {
  if (pendingTabAdoptions.size === 0) return;
  await Promise.allSettled([...pendingTabAdoptions.values()]);
}

async function adoptChildTab(tab, sourceTabId = null) {
  if (!Number.isInteger(tab?.id)) return false;

  await loadState();

  let openerTabId = Number.isInteger(sourceTabId)
    ? sourceTabId
    : Number.isInteger(tab.openerTabId)
      ? tab.openerTabId
      : null;
  if (openerTabId == null) return false;
  let ownerId = getTabOwnerId(openerTabId);

  const openerAdoption = pendingTabAdoptions.get(openerTabId);
  if (openerAdoption) await openerAdoption;
  ownerId ??= getTabOwnerId(openerTabId);

  if (!ownerId) return false;

  const existingOwnerId = getTabOwnerId(tab.id);
  if (existingOwnerId) return existingOwnerId === ownerId;

  const openerTab = await getTabIfValid(openerTabId);
  if (!openerTab) return false;

  let childTab = await chrome.tabs.get(tab.id);
  if (childTab.windowId !== openerTab.windowId) {
    const moved = await chrome.tabs.move(tab.id, {
      windowId: openerTab.windowId,
      index: -1,
    });
    childTab = Array.isArray(moved) ? moved[0] : moved;
  }

  agentWindowId = openerTab.windowId;
  const state = getOwnerState(ownerId);
  if (!state.tabIds.includes(childTab.id)) {
    state.tabIds.push(childTab.id);
  }
  state.activeTabId = childTab.id;
  touchOwnerTab(ownerId, childTab.id);

  try {
    await addToStellaGroup(childTab.id);
  } catch {}
  await saveState();
  return true;
}

function trackTabAdoption(tabId, attempt) {
  const previous = pendingTabAdoptions.get(tabId);
  const adoption = Promise.resolve(previous)
    .catch(() => {})
    .then(attempt)
    .finally(() => {
      if (pendingTabAdoptions.get(tabId) === adoption) {
        pendingTabAdoptions.delete(tabId);
      }
    });
  pendingTabAdoptions.set(tabId, adoption);
  void adoption.catch(() => {});
}

async function getOwnerTabs(ownerId, { ensureWindow = false } = {}) {
  await loadState();
  await awaitPendingTabAdoptions();
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
  const requestedTabId = getRequestedTabId(command);

  if (requestedTabId != null) {
    const requestedTab = tabs.find((tab) => tab.id === requestedTabId);
    if (!requestedTab) {
      throw new Error(
        `Tab ${requestedTabId} is not owned by command owner "${ownerId}"`,
      );
    }

    state.activeTabId = requestedTab.id;
    if (stellaGroupId != null && requestedTab.groupId !== stellaGroupId) {
      try {
        await chrome.tabs.group({
          tabIds: [requestedTab.id],
          groupId: stellaGroupId,
        });
      } catch {}
    }
    touchOwnerTab(ownerId, requestedTab.id);
    await saveState();
    return requestedTab;
  }

  if (state.activeTabId != null) {
    const activeTab = tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab) {
      if (stellaGroupId != null && activeTab.groupId !== stellaGroupId) {
        try {
          await chrome.tabs.group({
            tabIds: [activeTab.id],
            groupId: stellaGroupId,
          });
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

      const lastTouchedAt = Number(
        state.lastTouchedAtByTabId?.[String(tabId)] ?? now,
      );
      if (lastTouchedAt <= staleCutoff) {
        staleTabIds.push({ ownerId, tabId });
        changed = true;
        continue;
      }

      nextTabIds.push(tabId);
    }

    state.tabIds = nextTabIds;
    const nextActivity = normalizeTabActivity(
      state.lastTouchedAtByTabId,
      nextTabIds,
    );
    if (
      JSON.stringify(nextActivity) !==
      JSON.stringify(state.lastTouchedAtByTabId ?? {})
    ) {
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
      if (!group.title || group.title === "") {
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
    agentWindowId = null;
    stellaGroupId = null;
    await saveState();
  }
}

function validateKeepEntries(keep, ownedTabIds) {
  if (!Array.isArray(keep)) {
    throw new Error("finalize_tabs keep must be an array");
  }

  const seen = new Set();
  return keep.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`finalize_tabs keep entry ${index} must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== "tabId" && key !== "status")) {
      throw new Error(`finalize_tabs keep entry ${index} has unknown fields`);
    }
    if (!Number.isInteger(entry.tabId) || entry.tabId <= 0) {
      throw new Error(
        `finalize_tabs keep entry ${index} tabId must be a positive integer`,
      );
    }
    if (entry.status !== "handoff" && entry.status !== "deliverable") {
      throw new Error(
        `finalize_tabs keep entry ${index} status must be "handoff" or "deliverable"`,
      );
    }
    if (seen.has(entry.tabId)) {
      throw new Error(`finalize_tabs keep contains duplicate tabId ${entry.tabId}`);
    }
    if (!ownedTabIds.has(entry.tabId)) {
      throw new Error(
        `Tab ${entry.tabId} is not owned by the finalize_tabs command owner`,
      );
    }
    seen.add(entry.tabId);
    return { tabId: entry.tabId, status: entry.status };
  });
}

export async function finalizeOwnerTabs(command, keep = command?.keep ?? []) {
  await assertCurrentOwnerLease(command);
  const ownerId = getCommandOwnerId(command);
  const tabs = await getOwnerTabs(ownerId);
  const ownedTabIds = new Set(tabs.map((tab) => tab.id));
  const keepEntries = validateKeepEntries(keep, ownedTabIds);
  const releasedTabIds = keepEntries.map((entry) => entry.tabId);
  const releasedSet = new Set(releasedTabIds);
  const closedTabIds = tabs
    .map((tab) => tab.id)
    .filter((tabId) => !releasedSet.has(tabId));

  const failures = [];
  const forgetOwnedTab = (tabId) => {
    const state = ownerTabState[ownerId];
    if (!state) return;

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
  };

  for (const tabId of closedTabIds) {
    try {
      await assertCurrentOwnerLease(command);
      await chrome.tabs.remove(tabId);
      forgetOwnedTab(tabId);
    } catch (error) {
      failures.push({ tabId, operation: "close", error });
    }
  }

  for (const tabId of releasedTabIds) {
    try {
      await assertCurrentOwnerLease(command);
      await chrome.tabs.ungroup([tabId]);
      forgetOwnedTab(tabId);
    } catch (error) {
      failures.push({ tabId, operation: "release", error });
    }
  }

  await saveState();
  await validateAgentWindowAfterClose();
  if (failures.length > 0) {
    const details = failures
      .map(({ tabId, operation, error }) =>
        `${operation} tab ${tabId}: ${error?.message || String(error)}`,
      )
      .join("; ");
    throw new Error(`Failed to finalize owner tabs; ${details}`);
  }

  return {
    closedTabIds,
    releasedTabIds,
    kept: keepEntries,
  };
}

/**
 * Close Stella-owned tabs and reset owner state. When Stella is reusing the
 * user's Chrome window, this must not close the whole window.
 */
export async function closeAgentWindow() {
  const tabIds = Array.from(getOwnedTabIds());
  if (tabIds.length > 0) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch {}
  }

  resetAgentState({ clearLeases: true });
  await saveState();
}

export async function handleTabNew(command) {
  const ownerId = getCommandOwnerId(command);
  const tab = await createOwnerTab(ownerId, command.url || "about:blank");

  const tabs = await getOwnerTabs(ownerId, { ensureWindow: true });

  return {
    id: command.id,
    success: true,
    data: {
      tabId: tab.id,
      index: tabs.findIndex((item) => item.id === tab.id),
      total: tabs.length,
    },
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
        tabId: tab.id,
        index,
        url: tab.url || "",
        title: tab.title || "",
        active: tab.id === state.activeTabId,
      })),
      active: activeIndex,
      activeTabId: state.activeTabId,
    },
  };
}

export async function handleTabSwitch(command) {
  const ownerId = getCommandOwnerId(command);
  let tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const requestedTabId = getRequestedTabId(command);
  let index = command.index ?? 0;
  let tab;

  if (requestedTabId != null) {
    tab = await getActiveTab(command);
    tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
    index = tabs.findIndex((candidate) => candidate.id === tab.id);
  }

  if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  tab ??= tabs[index];
  const state = getOwnerState(ownerId);
  state.activeTabId = tab.id;
  touchOwnerTab(ownerId, tab.id);
  await saveState();

  return {
    id: command.id,
    success: true,
    data: {
      tabId: tab.id,
      index,
      url: tab.url || "",
      title: tab.title || "",
    },
  };
}

export async function handleTabClose(command) {
  const ownerId = getCommandOwnerId(command);
  let tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
  const state = getOwnerState(ownerId);
  const requestedTabId = getRequestedTabId(command);

  let index = command.index;
  let tab;
  if (requestedTabId != null) {
    tab = await getActiveTab(command);
    tabs = await getOwnerTabs(ownerId, { ensureWindow: true });
    index = tabs.findIndex((candidate) => candidate.id === tab.id);
  } else if (index === undefined || index === null) {
    index = tabs.findIndex((tab) => tab.id === state.activeTabId);
  }

  if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
    throw new Error(`Tab index ${index} out of range (0-${tabs.length - 1})`);
  }

  tab ??= tabs[index];
  // Authorization at dispatch is insufficient: tab discovery can overlap a
  // replacement kernel claiming this owner. Fence the destructive operation
  // itself so an already-admitted stale command cannot close the new lease's
  // tab session.
  await assertCurrentOwnerLease(command);
  clearTabRefMap(ownerId, tab.id);
  clearCdpEvents(tab.id);

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
      tabId: tab.id,
      closed: index,
      remaining: state.tabIds?.length ?? 0,
    },
  };
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab?.id)) return;
  trackTabAdoption(tab.id, () => adoptChildTab(tab));
});
chrome.webNavigation?.onCreatedNavigationTarget?.addListener((details) => {
  if (
    !Number.isInteger(details?.tabId) ||
    !Number.isInteger(details?.sourceTabId)
  ) {
    return;
  }
  trackTabAdoption(details.tabId, () =>
    adoptChildTab({ id: details.tabId }, details.sourceTabId),
  );
});

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
      agentWindowId = null;
      stellaGroupId = null;
      changed = true;
    }

    if (changed) {
      await saveState();
    }
  })().catch(() => {});
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== agentWindowId) return;

  agentWindowId = null;
  stellaGroupId = null;
  void saveState();
});
