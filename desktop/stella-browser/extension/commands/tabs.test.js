import assert from 'node:assert/strict';
import test from 'node:test';

const listeners = {
  tabCreated: [],
  tabRemoved: [],
  navigationTarget: [],
  windowRemoved: [],
};
const tabs = new Map([
  [1, { id: 1, windowId: 1, groupId: -1, url: 'https://user.example', title: 'User' }],
]);
const groups = new Map();
let nextTabId = 10;
let nextGroupId = 100;
let storage = {};
const removeFailures = new Set();
const ungroupFailures = new Set();

const clone = (value) => structuredClone(value);
const event = (bucket) => ({
  addListener(listener) {
    bucket.push(listener);
  },
});
globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(
          keys.filter((key) => storage[key] !== undefined).map((key) => [key, clone(storage[key])]),
        );
      },
      async set(value) {
        storage = { ...storage, ...clone(value) };
      },
    },
  },
  windows: {
    onRemoved: event(listeners.windowRemoved),
    async get(windowId) {
      if (windowId !== 1) throw new Error('window not found');
      return { id: 1, type: 'normal' };
    },
    async getLastFocused() {
      return { id: 1, type: 'normal' };
    },
    async getAll() {
      return [{ id: 1, type: 'normal' }];
    },
    async create({ url }) {
      const tab = { id: nextTabId++, windowId: 1, groupId: -1, url, title: '' };
      tabs.set(tab.id, tab);
      return { id: 1, tabs: [clone(tab)] };
    },
  },
  tabGroups: {
    async query({ title } = {}) {
      return [...groups.values()].filter((group) => !title || group.title === title).map(clone);
    },
    async get(groupId) {
      const group = groups.get(groupId);
      if (!group) throw new Error('group not found');
      return clone(group);
    },
    async update(groupId, updates) {
      const group = groups.get(groupId);
      if (!group) throw new Error('group not found');
      Object.assign(group, updates);
      return clone(group);
    },
  },
  tabs: {
    onCreated: event(listeners.tabCreated),
    onRemoved: event(listeners.tabRemoved),
    async create({ url, windowId }) {
      const tab = { id: nextTabId++, windowId, groupId: -1, url, title: '' };
      tabs.set(tab.id, tab);
      return clone(tab);
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('tab not found');
      return clone(tab);
    },
    async query(query) {
      return [...tabs.values()]
        .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
        .filter((tab) => query.groupId === undefined || tab.groupId === query.groupId)
        .map(clone);
    },
    async group({ tabIds, groupId, createProperties }) {
      const resolvedGroupId = groupId ?? nextGroupId++;
      if (!groups.has(resolvedGroupId)) {
        groups.set(resolvedGroupId, {
          id: resolvedGroupId,
          windowId: createProperties?.windowId ?? tabs.get(tabIds[0]).windowId,
          title: '',
          color: 'grey',
        });
      }
      for (const tabId of tabIds) tabs.get(tabId).groupId = resolvedGroupId;
      return resolvedGroupId;
    },
    async ungroup(tabIds) {
      for (const tabId of tabIds) {
        if (ungroupFailures.has(tabId)) throw new Error(`ungroup failed for ${tabId}`);
        const tab = tabs.get(tabId);
        if (tab) tab.groupId = -1;
      }
    },
    async move(tabId, { windowId }) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('tab not found');
      tab.windowId = windowId;
      return clone(tab);
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        if (removeFailures.has(tabId)) throw new Error(`remove failed for ${tabId}`);
        tabs.delete(tabId);
      }
    },
  },
  debugger: {
    onEvent: event([]),
    onDetach: event([]),
  },
  webNavigation: {
    onCreatedNavigationTarget: event(listeners.navigationTarget),
  },
};

const {
  authorizeOwnerLease,
  finalizeOwnerTabs,
  getActiveTab,
  handleTabClose,
  handleTabList,
  handleTabNew,
  handleTabSwitch,
  releaseOwnerLease,
} = await import('./tabs.js');

test('tab responses expose stable IDs and explicit targeting stays owner-scoped', async () => {
  for (const ownerId of ['__proto__', 'prototype', 'constructor']) {
    await assert.rejects(
      handleTabNew({ id: `unsafe-${ownerId}`, ownerId }),
      /Unsafe ownerId/,
    );
  }

  const first = await handleTabNew({ id: 'new-a', ownerId: 'owner-a' });
  const second = await handleTabNew({ id: 'new-b', ownerId: 'owner-b' });
  assert.equal(Number.isInteger(first.data.tabId), true);
  assert.equal(Number.isInteger(second.data.tabId), true);
  assert.notEqual(first.data.tabId, second.data.tabId);

  const list = await handleTabList({ id: 'list-a', ownerId: 'owner-a' });
  assert.equal(list.data.tabs[0].tabId, first.data.tabId);
  assert.equal(list.data.activeTabId, first.data.tabId);

  const switched = await handleTabSwitch({
    id: 'switch-a',
    ownerId: 'owner-a',
    tabId: first.data.tabId,
  });
  assert.equal(switched.data.tabId, first.data.tabId);
  await assert.rejects(
    getActiveTab({ ownerId: 'owner-a', tabId: second.data.tabId }),
    /not owned by command owner/,
  );

  tabs.set(999, { id: 999, windowId: 1, groupId: -1, url: 'https://unowned.example' });
  await assert.rejects(
    getActiveTab({ ownerId: 'owner-a', tabId: 999 }),
    /not owned by command owner/,
  );

  const closed = await handleTabClose({
    id: 'close-b',
    ownerId: 'owner-b',
    tabId: second.data.tabId,
  });
  assert.equal(closed.data.tabId, second.data.tabId);
  assert.equal(tabs.has(second.data.tabId), false);
});

test('opener child tabs are adopted and finalization only touches owner tabs', async () => {
  const ownerTab = await handleTabNew({ id: 'owner-new', ownerId: 'owner-finalize' });
  const unrelated = await handleTabNew({ id: 'other-new', ownerId: 'owner-unrelated' });
  const child = {
    id: nextTabId++,
    openerTabId: ownerTab.data.tabId,
    windowId: 1,
    groupId: -1,
    url: 'https://child.example',
    title: 'Child',
  };
  tabs.set(child.id, child);
  for (const listener of listeners.tabCreated) listener(clone(child));

  const list = await handleTabList({ id: 'list-child', ownerId: 'owner-finalize' });
  assert.deepEqual(
    list.data.tabs.map((tab) => tab.tabId),
    [ownerTab.data.tabId, child.id],
  );
  assert.equal(list.data.activeTabId, child.id);
  assert.notEqual(tabs.get(child.id).groupId, -1);

  const finalized = await finalizeOwnerTabs({
    id: 'finalize',
    ownerId: 'owner-finalize',
    keep: [{ tabId: child.id, status: 'handoff' }],
  });
  assert.deepEqual(finalized.closedTabIds, [ownerTab.data.tabId]);
  assert.deepEqual(finalized.releasedTabIds, [child.id]);
  assert.equal(tabs.has(ownerTab.data.tabId), false);
  assert.equal(tabs.get(child.id).groupId, -1);
  assert.equal(tabs.has(unrelated.data.tabId), true);

  await assert.rejects(
    getActiveTab({ ownerId: 'owner-finalize', tabId: child.id }),
    /not owned by command owner/,
  );
  const unrelatedList = await handleTabList({ id: 'other-list', ownerId: 'owner-unrelated' });
  assert.equal(unrelatedList.data.tabs[0].tabId, unrelated.data.tabId);
});

test('navigation target source adopts noopener tabs after the click action', async () => {
  const ownerTab = await handleTabNew({ id: 'source-owner', ownerId: 'owner-source' });
  const child = {
    id: nextTabId++,
    windowId: 1,
    groupId: -1,
    url: 'about:blank',
    title: '',
  };
  tabs.set(child.id, child);
  for (const listener of listeners.tabCreated) listener(clone(child));
  for (const listener of listeners.navigationTarget) {
    listener({ sourceTabId: ownerTab.data.tabId, tabId: child.id });
  }

  const list = await handleTabList({ id: 'source-list', ownerId: 'owner-source' });
  assert.deepEqual(
    list.data.tabs.map((tab) => tab.tabId),
    [ownerTab.data.tabId, child.id],
  );
  assert.equal(list.data.activeTabId, child.id);
});

test('opener-less tabs are not adopted without an authoritative source event', async () => {
  const ownerTab = await handleTabNew({ id: 'unrelated-owner', ownerId: 'owner-unrelated-tab' });
  const unrelated = {
    id: nextTabId++,
    windowId: 1,
    groupId: -1,
    url: 'https://user.example/unrelated',
    title: 'Unrelated',
  };
  tabs.set(unrelated.id, unrelated);
  for (const listener of listeners.tabCreated) listener(clone(unrelated));

  const list = await handleTabList({ id: 'unrelated-list', ownerId: 'owner-unrelated-tab' });
  assert.deepEqual(list.data.tabs.map((tab) => tab.tabId), [ownerTab.data.tabId]);
  assert.equal(tabs.get(unrelated.id).groupId, -1);
});

test('finalization rejects cross-owner keep entries before changing state', async () => {
  const own = await handleTabNew({ id: 'own', ownerId: 'owner-keep' });
  const other = await handleTabNew({ id: 'other', ownerId: 'owner-other' });

  await assert.rejects(
    finalizeOwnerTabs({
      id: 'bad-finalize',
      ownerId: 'owner-keep',
      keep: [{ tabId: other.data.tabId, status: 'deliverable' }],
    }),
    /not owned/,
  );
  assert.equal(tabs.has(own.data.tabId), true);
  assert.equal(tabs.has(other.data.tabId), true);
});

test('failed close_owner operations retain ownership for retry', async () => {
  const owned = await handleTabNew({ id: 'retry-new', ownerId: 'owner-retry' });
  removeFailures.add(owned.data.tabId);

  await assert.rejects(
    finalizeOwnerTabs({ id: 'retry-close', ownerId: 'owner-retry', keep: [] }),
    /close tab .*remove failed/,
  );
  const retained = await handleTabList({ id: 'retry-list', ownerId: 'owner-retry' });
  assert.deepEqual(retained.data.tabs.map((tab) => tab.tabId), [owned.data.tabId]);

  removeFailures.delete(owned.data.tabId);
  const retried = await finalizeOwnerTabs({
    id: 'retry-close-again',
    ownerId: 'owner-retry',
    keep: [],
  });
  assert.deepEqual(retried.closedTabIds, [owned.data.tabId]);
  assert.equal(tabs.has(owned.data.tabId), false);
});

test('failed handoff operations retain ownership for retry', async () => {
  const owned = await handleTabNew({ id: 'retry-release', ownerId: 'owner-release' });
  ungroupFailures.add(owned.data.tabId);

  await assert.rejects(
    finalizeOwnerTabs({
      id: 'retry-release-finalize',
      ownerId: 'owner-release',
      keep: [{ tabId: owned.data.tabId, status: 'handoff' }],
    }),
    /release tab .*ungroup failed/,
  );
  const retained = await handleTabList({ id: 'release-list', ownerId: 'owner-release' });
  assert.deepEqual(retained.data.tabs.map((tab) => tab.tabId), [owned.data.tabId]);

  ungroupFailures.delete(owned.data.tabId);
  const retried = await finalizeOwnerTabs({
    id: 'retry-release-again',
    ownerId: 'owner-release',
    keep: [{ tabId: owned.data.tabId, status: 'handoff' }],
  });
  assert.deepEqual(retried.releasedTabIds, [owned.data.tabId]);
  assert.equal(tabs.get(owned.data.tabId).groupId, -1);
});

test('window drift preserves valid owned tabs in the registry', async () => {
  const owned = await handleTabNew({ id: 'drift-new', ownerId: 'owner-drift' });
  tabs.get(owned.data.tabId).windowId = 2;
  for (const listener of listeners.windowRemoved) listener(1);
  await new Promise((resolve) => setImmediate(resolve));

  const listed = await handleTabList({ id: 'drift-list', ownerId: 'owner-drift' });
  assert.deepEqual(listed.data.tabs.map((tab) => tab.tabId), [owned.data.tabId]);
  assert.equal(tabs.has(owned.data.tabId), true);
});

test('replacement lease fences stale cleanup from an older kernel', async () => {
  const firstLease = {
    id: 'lease-first',
    action: 'tab_new',
    ownerId: 'owner-lease',
    ownerLeaseId: 'kernel-1',
    ownerLeaseIssuedAt: 100,
  };
  const replacementLease = {
    id: 'lease-replacement',
    action: 'tab_list',
    ownerId: 'owner-lease',
    ownerLeaseId: 'kernel-2',
    ownerLeaseIssuedAt: 200,
  };
  await authorizeOwnerLease(firstLease);
  const owned = await handleTabNew(firstLease);
  await authorizeOwnerLease(replacementLease);

  await assert.rejects(
    authorizeOwnerLease({ ...firstLease, id: 'stale-close', action: 'close_owner' }),
    /Stale browser owner lease rejected/,
  );
  assert.equal(tabs.has(owned.data.tabId), true);
  const listed = await handleTabList(replacementLease);
  assert.deepEqual(listed.data.tabs.map((tab) => tab.tabId), [owned.data.tabId]);
});

test('in-flight tab close rechecks its lease after replacement', async () => {
  const firstLease = {
    id: 'in-flight-first',
    action: 'tab_new',
    ownerId: 'owner-in-flight',
    ownerLeaseId: 'kernel-old',
    ownerLeaseIssuedAt: 300,
  };
  const replacementLease = {
    id: 'in-flight-replacement',
    action: 'tab_list',
    ownerId: 'owner-in-flight',
    ownerLeaseId: 'kernel-new',
    ownerLeaseIssuedAt: 400,
  };
  await authorizeOwnerLease(firstLease);
  const owned = await handleTabNew(firstLease);

  const originalGet = chrome.tabs.get;
  let resumeGet;
  let getStarted;
  const getStartedPromise = new Promise((resolve) => { getStarted = resolve; });
  const resumeGetPromise = new Promise((resolve) => { resumeGet = resolve; });
  chrome.tabs.get = async (tabId) => {
    getStarted();
    await resumeGetPromise;
    return originalGet(tabId);
  };

  try {
    const staleClose = handleTabClose({
      ...firstLease,
      id: 'in-flight-close',
      action: 'tab_close',
      tabId: owned.data.tabId,
    });
    await getStartedPromise;
    await authorizeOwnerLease(replacementLease);
    resumeGet();

    await assert.rejects(staleClose, /Stale browser owner lease rejected/);
    assert.equal(tabs.has(owned.data.tabId), true);
  } finally {
    chrome.tabs.get = originalGet;
    resumeGet?.();
  }
});

test('lease release is non-destructive and permits later sessions without growth', async () => {
  const lease = {
    id: 'release-lease',
    action: 'tab_new',
    ownerId: 'owner-release-lease',
    ownerLeaseId: 'short-lived-session',
    ownerLeaseIssuedAt: 500,
  };
  await authorizeOwnerLease(lease);
  const owned = await handleTabNew(lease);
  await releaseOwnerLease(lease);

  await authorizeOwnerLease({
    ...lease,
    id: 'replacement-after-release',
    ownerLeaseId: 'later-session',
    ownerLeaseIssuedAt: 1,
  });
  assert.equal(tabs.has(owned.data.tabId), true);
});
