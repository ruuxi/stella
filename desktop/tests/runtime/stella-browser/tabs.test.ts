import { afterEach, describe, expect, it, vi } from "vitest";

type TabsModule = typeof import("../../../stella-browser/extension/commands/tabs.js");

type MockTab = {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
};

type MockGroup = {
  id: number;
  windowId: number;
  title: string;
  color: string;
};

type MockWindow = {
  id: number;
};

type MockOptions = {
  asyncWindowCreate?: boolean;
};

type Listener<TArgs extends unknown[]> = (...args: TArgs) => void | Promise<void>;

const createEvent = <TArgs extends unknown[]>() => {
  const listeners: Listener<TArgs>[] = [];
  return {
    addListener(listener: Listener<TArgs>) {
      listeners.push(listener);
    },
    async emit(...args: TArgs) {
      for (const listener of listeners) {
        await listener(...args);
      }
    },
  };
};

const createChromeMock = (mockOptions: MockOptions = {}) => {
  const sessionState: Record<string, unknown> = {};
  const windows = new Map<number, MockWindow>();
  const tabs = new Map<number, MockTab>();
  const groups = new Map<number, MockGroup>();
  const stats = { windowsCreated: 0 };

  let nextWindowId = 1;
  let nextTabId = 1;
  let nextGroupId = 1;

  const tabsRemoved = createEvent<[number, { windowId: number; isWindowClosing: boolean }]>();
  const windowsRemoved = createEvent<[number]>();
  const debuggerEvents = createEvent<[{ tabId?: number }, string, unknown]>();
  const debuggerDetached = createEvent<[{ tabId?: number }, string]>();

  const cloneTab = (tab: MockTab) => ({ ...tab });
  const cloneGroup = (group: MockGroup) => ({ ...group });
  const cloneWindow = (window: MockWindow) => ({ ...window });

  const getTabsForWindow = (windowId: number) =>
    Array.from(tabs.values())
      .filter((tab) => tab.windowId === windowId)
      .sort((left, right) => left.id - right.id);

  const getTabsForGroup = (groupId: number) =>
    Array.from(tabs.values())
      .filter((tab) => tab.groupId === groupId)
      .sort((left, right) => left.id - right.id);

  const removeEmptyGroups = () => {
    for (const [groupId] of groups) {
      if (getTabsForGroup(groupId).length === 0) {
        groups.delete(groupId);
      }
    }
  };

  const createTab = (params: { windowId: number; url?: string; active?: boolean }) => {
    const tab: MockTab = {
      id: nextTabId++,
      windowId: params.windowId,
      groupId: -1,
      url: params.url ?? "about:blank",
      title: params.url ?? "about:blank",
      active: params.active ?? false,
    };
    tabs.set(tab.id, tab);
    return tab;
  };

  const chrome = {
    storage: {
      session: {
        async get(keys?: string[] | string) {
          if (!keys) {
            return { ...sessionState };
          }
          const keyList = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            keyList
              .filter((key) => Object.prototype.hasOwnProperty.call(sessionState, key))
              .map((key) => [key, sessionState[key]]),
          );
        },
        async set(values: Record<string, unknown>) {
          Object.assign(sessionState, values);
        },
      },
    },
    tabGroups: {
      async query(queryInfo: { title?: string }) {
        return Array.from(groups.values())
          .filter((group) => queryInfo.title === undefined || group.title === queryInfo.title)
          .map(cloneGroup);
      },
      async get(groupId: number) {
        const group = groups.get(groupId);
        if (!group) {
          throw new Error(`Unknown group ${groupId}`);
        }
        return cloneGroup(group);
      },
      async update(groupId: number, updateInfo: Partial<MockGroup>) {
        const group = groups.get(groupId);
        if (!group) {
          throw new Error(`Unknown group ${groupId}`);
        }
        Object.assign(group, updateInfo);
        return cloneGroup(group);
      },
    },
    windows: {
      onRemoved: windowsRemoved,
      async create(options: { url?: string }) {
        if (mockOptions.asyncWindowCreate) {
          await Promise.resolve();
        }
        const window: MockWindow = { id: nextWindowId++ };
        windows.set(window.id, window);
        stats.windowsCreated += 1;
        createTab({ windowId: window.id, url: options.url, active: true });
        return cloneWindow(window);
      },
      async get(windowId: number) {
        const window = windows.get(windowId);
        if (!window) {
          throw new Error(`Unknown window ${windowId}`);
        }
        return cloneWindow(window);
      },
      async remove(windowId: number) {
        if (!windows.has(windowId)) {
          throw new Error(`Unknown window ${windowId}`);
        }
        await chrome.tabs.remove(getTabsForWindow(windowId).map((tab) => tab.id));
      },
    },
    tabs: {
      onRemoved: tabsRemoved,
      async query(queryInfo: { windowId?: number; groupId?: number }) {
        return Array.from(tabs.values())
          .filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId)
          .filter((tab) => queryInfo.groupId === undefined || tab.groupId === queryInfo.groupId)
          .sort((left, right) => left.id - right.id)
          .map(cloneTab);
      },
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error(`Unknown tab ${tabId}`);
        }
        return cloneTab(tab);
      },
      async create(options: { url?: string; active?: boolean; windowId: number }) {
        if (!windows.has(options.windowId)) {
          throw new Error(`Unknown window ${options.windowId}`);
        }
        return cloneTab(
          createTab({
            windowId: options.windowId,
            url: options.url,
            active: options.active,
          }),
        );
      },
      async update(tabId: number, updateInfo: Partial<MockTab>) {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error(`Unknown tab ${tabId}`);
        }
        Object.assign(tab, updateInfo);
        return cloneTab(tab);
      },
      async group(options: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId: number };
      }) {
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        const groupedTabs = tabIds.map((tabId) => {
          const tab = tabs.get(tabId);
          if (!tab) {
            throw new Error(`Unknown tab ${tabId}`);
          }
          return tab;
        });

        let groupId = options.groupId;
        if (groupId == null) {
          const windowId = options.createProperties?.windowId ?? groupedTabs[0]?.windowId;
          if (!Number.isInteger(windowId)) {
            throw new Error("A window is required to create a group.");
          }
          groupId = nextGroupId++;
          groups.set(groupId, {
            id: groupId,
            windowId,
            title: "",
            color: "grey",
          });
        } else if (!groups.has(groupId)) {
          throw new Error(`Unknown group ${groupId}`);
        }

        for (const tab of groupedTabs) {
          tab.groupId = groupId;
        }
        removeEmptyGroups();
        return groupId;
      },
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          const tab = tabs.get(tabId);
          if (!tab) continue;
          tab.groupId = -1;
        }
        removeEmptyGroups();
      },
      async remove(tabIds: number[] | number) {
        const ids = [...new Set(Array.isArray(tabIds) ? tabIds : [tabIds])];
        const removeInfoByTabId = new Map<number, { windowId: number; isWindowClosing: boolean }>();
        const windowsClosing = new Set<number>();

        for (const tabId of ids) {
          const tab = tabs.get(tabId);
          if (!tab) {
            throw new Error(`Unknown tab ${tabId}`);
          }
        }

        for (const windowId of new Set(ids.map((tabId) => tabs.get(tabId)?.windowId ?? -1))) {
          const removedInWindow = new Set(
            ids.filter((tabId) => tabs.get(tabId)?.windowId === windowId),
          );
          const remaining = getTabsForWindow(windowId).filter((tab) => !removedInWindow.has(tab.id));
          const isWindowClosing = remaining.length === 0;
          if (isWindowClosing) {
            windowsClosing.add(windowId);
          }
          for (const tabId of removedInWindow) {
            removeInfoByTabId.set(tabId, { windowId, isWindowClosing });
          }
        }

        for (const tabId of ids) {
          tabs.delete(tabId);
        }
        removeEmptyGroups();

        for (const tabId of ids) {
          const removeInfo = removeInfoByTabId.get(tabId);
          if (removeInfo) {
            await tabsRemoved.emit(tabId, removeInfo);
          }
        }

        for (const windowId of windowsClosing) {
          windows.delete(windowId);
          await windowsRemoved.emit(windowId);
        }
      },
    },
    debugger: {
      onEvent: debuggerEvents,
      onDetach: debuggerDetached,
      async attach() {},
      async detach() {},
    },
  };

  return {
    chrome,
    state: {
      sessionState,
      windows,
      tabs,
      groups,
      stats,
    },
  };
};

const loadTabsModule = async (options: MockOptions = {}) => {
  vi.resetModules();
  const mock = createChromeMock(options);
  vi.stubGlobal("chrome", mock.chrome);
  const module = (await import(
    "../../../stella-browser/extension/commands/tabs.js"
  )) as TabsModule;
  return { module, state: mock.state };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("stella-browser shared tab group", () => {
  it("keeps a parking tab so later owners reuse the same Stella group", async () => {
    const { module, state } = await loadTabsModule();

    await module.handleTabNew({
      id: "first",
      ownerId: "owner-a",
      url: "https://example.com",
    });

    const parkingTabId = state.sessionState.parkingTabId as number;
    expect(state.stats.windowsCreated).toBe(1);
    expect(state.groups.size).toBe(1);
    expect(state.tabs.size).toBe(2);
    expect(state.tabs.has(parkingTabId)).toBe(true);

    await module.closeOwnerTabs("owner-a");

    expect(state.stats.windowsCreated).toBe(1);
    expect(state.windows.size).toBe(1);
    expect(state.groups.size).toBe(1);
    expect(Array.from(state.tabs.keys())).toEqual([parkingTabId]);

    await module.handleTabNew({
      id: "second",
      ownerId: "owner-b",
      url: "https://cursor.com",
    });

    expect(state.stats.windowsCreated).toBe(1);
    expect(state.windows.size).toBe(1);
    expect(state.groups.size).toBe(1);
    expect(state.tabs.size).toBe(2);
  });

  it("auto-closes tabs that have been inactive for over 24 hours", async () => {
    const { module, state } = await loadTabsModule();

    await module.handleTabNew({
      id: "stale",
      ownerId: "owner-a",
      url: "https://example.com/stale",
    });

    const parkingTabId = state.sessionState.parkingTabId as number;
    const ownerState = (state.sessionState.ownerTabState as Record<string, any>)["owner-a"];
    const staleTabId = ownerState.tabIds.find((tabId: number) => tabId !== parkingTabId);
    ownerState.lastTouchedAtByTabId[String(staleTabId)] =
      Date.now() - 25 * 60 * 60 * 1000;

    await module.cleanupStaleTabs({ now: Date.now() });

    expect(state.tabs.has(staleTabId)).toBe(false);
    expect(state.tabs.has(parkingTabId)).toBe(true);
    expect((state.sessionState.ownerTabState as Record<string, unknown>)["owner-a"]).toBeUndefined();
    expect(state.windows.size).toBe(1);
  });

  it("serializes shared-window creation across concurrent owners", async () => {
    const { module, state } = await loadTabsModule({ asyncWindowCreate: true });

    await Promise.all([
      module.handleTabNew({ id: "a", ownerId: "owner-a", url: "https://a.example" }),
      module.handleTabNew({ id: "b", ownerId: "owner-b", url: "https://b.example" }),
    ]);

    expect(state.stats.windowsCreated).toBe(1);
    expect(state.windows.size).toBe(1);
    expect(state.groups.size).toBe(1);
    expect(state.tabs.size).toBe(3);
  });
});
