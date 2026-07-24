import { describe, expect, it, vi } from "vitest";

import {
  installBrowserWorkerApi,
  type BrowserWorkerCall,
} from "../../../../../runtime/kernel/browser-use/worker-api.js";

type RecordedCall = {
  method: "command" | "chain";
  args: readonly unknown[];
};

const semantic = (payload: Record<string, unknown>) =>
  `aria=${encodeURIComponent(JSON.stringify(payload))}`;

describe("browser worker API", () => {
  it("is self-contained when stringified and deeply freezes public roots", async () => {
    const restored = (0, eval)(
      `(${installBrowserWorkerApi.toString()})`,
    ) as typeof installBrowserWorkerApi;
    const browser = restored(async (method, args) => {
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [
              {
                tabId: 7,
                title: "Example",
                url: "https://example.com",
                active: true,
              },
            ],
            activeTabId: 7,
          },
        };
      }
      return { success: true, data: {} };
    });

    const [tab] = await browser.tabs.list();
    const locator = tab!.playwright.getByRole("button", { name: "Save" });

    expect(Object.isFrozen(browser)).toBe(true);
    expect(Object.isFrozen(browser.tabs)).toBe(true);
    expect(Object.isFrozen(tab)).toBe(true);
    expect(Object.isFrozen(tab!.playwright)).toBe(true);
    expect(Object.isFrozen(locator)).toBe(true);
    expect("run" in browser).toBe(false);
    expect(browser.documentation()).toContain(
      "multiple awaited browser actions",
    );
    expect(browser.documentation()).toContain("Do not add sleeps");
  });

  it("normalizes tab payloads and preserves Tab identity across the graph", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      const action = args[0];
      if (method === "command" && action === "tab_list") {
        return {
          result: {
            success: true,
            data: {
              tabs: [
                {
                  tabId: "41",
                  title: "First",
                  url: "https://first.test",
                  active: true,
                },
              ],
              activeTabId: "41",
            },
          },
        };
      }
      if (method === "command" && action === "tab_new") {
        return { success: true, data: { tabId: 52 } };
      }
      return { success: true, data: {} };
    });
    const browser = installBrowserWorkerApi(callBrowser);

    const firstList = await browser.tabs.list();
    const secondList = await browser.tabs.list();
    const selected = await browser.tabs.selected();
    const created = await browser.tabs.new("https://new.test");

    expect(firstList[0]).toBe(secondList[0]);
    expect(firstList[0]).toBe(browser.tabs.get(41));
    expect(selected).toBe(firstList[0]);
    expect(created).toBe(browser.tabs.get(52));
    expect(created.id).toBe(52);
    expect(calls.at(-1)).toEqual({
      method: "command",
      args: ["tab_new", { url: "https://new.test" }],
    });
  });

  it("fails loudly when a legacy extension returns index-only tab payloads", async () => {
    const browser = installBrowserWorkerApi(async (method, args) => {
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [{ index: 0, title: "Legacy" }],
            active: 0,
          },
        };
      }
      if (method === "command" && args[0] === "tab_new") {
        return { success: true, data: { index: 0, total: 1 } };
      }
      return { success: true, data: {} };
    });

    await expect(browser.tabs.list()).rejects.toThrow(
      /protocol mismatch.*stable positive tabId.*1\.2\.6/i,
    );
    await expect(browser.tabs.new()).rejects.toThrow(
      /protocol mismatch.*tab_new returned no stable tabId.*1\.2\.6/i,
    );
  });

  it("translates every Tab operation to a structured action with tabId", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      const action = args[0];
      if (action === "url") {
        return { success: true, data: { url: "https://after.test" } };
      }
      if (action === "title") {
        return { success: true, data: { title: "After" } };
      }
      if (action === "snapshot") {
        return { success: true, data: { snapshot: "tree" } };
      }
      return { success: true, data: { ok: true } };
    });
    const tab = installBrowserWorkerApi(callBrowser).tabs.get(9);

    await tab.goto("https://example.test", { waitUntil: "none", timeout: 500 });
    await tab.back();
    await tab.forward();
    await tab.reload({ timeout: 750 });
    await expect(tab.url()).resolves.toBe("https://after.test");
    await expect(tab.title()).resolves.toBe("After");
    await expect(
      tab.snapshot({ interactive: true, maxDepth: 3 }),
    ).resolves.toBe("tree");
    await tab.screenshot({ fullPage: true, format: "png" });
    await tab.close();

    expect(calls).toEqual([
      {
        method: "command",
        args: [
          "navigate",
          {
            tabId: 9,
            url: "https://example.test",
            waitUntil: "none",
            timeout: 500,
          },
        ],
      },
      { method: "command", args: ["back", { tabId: 9 }] },
      { method: "command", args: ["forward", { tabId: 9 }] },
      { method: "command", args: ["reload", { tabId: 9, timeout: 750 }] },
      { method: "command", args: ["url", { tabId: 9 }] },
      { method: "command", args: ["title", { tabId: 9 }] },
      {
        method: "command",
        args: ["snapshot", { tabId: 9, interactive: true, maxDepth: 3 }],
      },
      {
        method: "command",
        args: ["screenshot", { tabId: 9, fullPage: true, format: "png" }],
      },
      { method: "command", args: ["tab_close", { tabId: 9 }] },
    ]);
  });

  it("encodes semantic selectors deterministically and re-encodes nth", async () => {
    const calls: RecordedCall[] = [];
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return { success: true, data: { clicked: true } };
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(17).playwright;
    const save = playwright.getByRole("button", {
      name: "Save / close",
      exact: true,
    });

    expect(
      playwright.getByRole("button", {
        name: "Save / close",
        exact: true,
      }),
    ).toBe(save);
    await save.click();
    await save.nth(2).click();
    await playwright.getByText("Continue?", { exact: false }).click();
    await playwright.getByLabel("Email").fill("a@example.com");
    await playwright.getByPlaceholder("Search").type("query");
    await playwright.getByTestId("submit-button").click();

    const role = {
      kind: "role",
      role: "button",
      name: "Save / close",
      exact: true,
    };
    expect(calls[0]).toEqual({
      method: "command",
      args: ["click", { tabId: 17, selector: semantic(role) }],
    });
    expect(calls[1]).toEqual({
      method: "command",
      args: ["click", { tabId: 17, selector: semantic({ ...role, nth: 2 }) }],
    });
    expect(calls.slice(2)).toEqual([
      {
        method: "command",
        args: [
          "click",
          {
            tabId: 17,
            selector: semantic({
              kind: "text",
              value: "Continue?",
              exact: false,
            }),
          },
        ],
      },
      {
        method: "command",
        args: [
          "fill",
          {
            tabId: 17,
            selector: semantic({ kind: "label", value: "Email", exact: false }),
            value: "a@example.com",
          },
        ],
      },
      {
        method: "command",
        args: [
          "type",
          {
            tabId: 17,
            selector: semantic({
              kind: "placeholder",
              value: "Search",
              exact: false,
            }),
            text: "query",
          },
        ],
      },
      {
        method: "command",
        args: [
          "click",
          {
            tabId: 17,
            selector: semantic({
              kind: "testid",
              value: "submit-button",
              exact: false,
            }),
          },
        ],
      },
    ]);
  });

  it("uses a marker chain for positional CSS interactions", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { filled: true },
    }));
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator("#results > .row")
      .nth(3);

    await locator.fill("chosen");

    expect(callBrowser).toHaveBeenCalledWith(
      "chain",
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            action: "evaluate",
            params: expect.objectContaining({
              tabId: 6,
              script: expect.stringContaining('"index":3'),
            }),
          }),
          expect.objectContaining({
            action: "fill",
            params: expect.objectContaining({
              tabId: 6,
              selector: expect.stringContaining("data-stella-worker-locator"),
              value: "chosen",
            }),
          }),
        ]),
        expect.objectContaining({ abortOnError: false, waitForSelector: false }),
      ]),
    );
    expect(callBrowser).toHaveBeenLastCalledWith("command", [
      "evaluate",
      expect.objectContaining({
        tabId: 6,
        script: expect.stringContaining("removeAttribute"),
      }),
    ]);
  });

  it("runs filtered-locator cleanup in a separate finally command", async () => {
    const calls: RecordedCall[] = [];
    let failAction = false;
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      return {
        success: true,
        data: {
          results: [
            { success: true, data: true },
            failAction
              ? { success: false, error: "click failed" }
              : { success: true, data: { clicked: true } },
          ],
        },
      };
    });
    const locator = installBrowserWorkerApi(callBrowser)
      .tabs.get(6)
      .playwright.locator(".row")
      .filter({ hasText: "Ready" });

    await expect(locator.click()).resolves.toEqual({ clicked: true });
    const [steps, options] = calls[0]!.args;
    expect(options).toEqual({ abortOnError: false, waitForSelector: false });
    expect(steps).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });

    failAction = true;
    await expect(locator.click()).rejects.toThrow("click failed");
    expect(calls[2]?.args[0] as unknown[]).toHaveLength(2);
    expect(calls[3]).toMatchObject({
      method: "command",
      args: [
        "evaluate",
        expect.objectContaining({
          script: expect.stringContaining("removeAttribute"),
        }),
      ],
    });
  });

  it("normalizes locator read payloads and keeps Locator identity stable", async () => {
    const callBrowser: BrowserWorkerCall = vi.fn(async (_method, args) => {
      switch (args[0]) {
        case "count":
          return { result: { success: true, data: { count: "3" } } };
        case "innertext":
          return { success: true, data: { text: "Hello" } };
        case "gettext":
          return { success: true, data: { text: null } };
        case "inputvalue":
          return { success: true, data: { value: "typed" } };
        case "getattribute":
          return { success: true, data: { value: "/next" } };
        case "isvisible":
          return { success: true, data: { visible: true } };
        case "isenabled":
          return { success: true, data: { enabled: false } };
        case "ischecked":
          return { success: true, data: { checked: "true" } };
        case "boundingbox":
          return {
            success: true,
            data: { box: { x: 1, y: 2, width: 3, height: 4 } },
          };
        default:
          return { success: true, data: {} };
      }
    });
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(2).playwright;
    const locator = playwright.locator("#field");

    expect(playwright.locator("#field")).toBe(locator);
    await expect(locator.count()).resolves.toBe(3);
    await expect(locator.innerText()).resolves.toBe("Hello");
    await expect(locator.textContent()).resolves.toBeNull();
    await expect(locator.inputValue()).resolves.toBe("typed");
    await expect(locator.getAttribute("href")).resolves.toBe("/next");
    await expect(locator.isVisible()).resolves.toBe(true);
    await expect(locator.isEnabled()).resolves.toBe(false);
    await expect(locator.isChecked()).resolves.toBe(true);
    await expect(locator.boundingBox()).resolves.toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("captures exactly one newly adopted owned tab around an action", async () => {
    const calls: RecordedCall[] = [];
    let childCreated = false;
    const callBrowser: BrowserWorkerCall = vi.fn(async (method, args) => {
      calls.push({ method, args });
      if (method === "command" && args[0] === "tab_list") {
        return {
          success: true,
          data: {
            tabs: [
              { tabId: 10, url: "https://parent.test", active: !childCreated },
              ...(childCreated
                ? [{ tabId: 11, url: "https://child.test", active: true }]
                : []),
            ],
            activeTabId: childCreated ? 11 : 10,
          },
        };
      }
      if (method === "command" && args[0] === "click") {
        childCreated = true;
      }
      return { success: true, data: {} };
    });
    const browser = installBrowserWorkerApi(callBrowser);
    const parent = browser.tabs.get(10);

    const child = await parent.expectNewTab(async () => {
      await parent.playwright.getByText("Open report").click();
    });

    expect(child.id).toBe(11);
    expect(child).toBe(browser.tabs.get(11));
    expect(calls.map((entry) => entry.args[0])).toEqual([
      "tab_list",
      "click",
      "tab_list",
    ]);
  });

  it("sanitizes structured chains and rejects nested or arbitrary actions", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { completed: 2 },
    }));
    const browser = installBrowserWorkerApi(callBrowser);
    const steps = [
      { action: "click", params: { tabId: 4, selector: "#save" } },
      { action: "title", params: { tabId: 4 } },
    ];

    await browser.chain(steps, { abortOnError: true, waitForSelector: false });

    expect(callBrowser).toHaveBeenCalledWith("chain", [
      steps,
      { abortOnError: true, waitForSelector: false },
    ]);
    await expect(
      browser.chain([{ action: "chain", params: { tabId: 4 } }]),
    ).rejects.toThrow("nested chain");
    await expect(
      browser.chain([{ action: "cookies_get", params: { tabId: 4 } }]),
    ).rejects.toThrow("unsupported action");
    await expect(
      browser.chain([{ action: "click", params: { selector: "#save" } }]),
    ).rejects.toThrow("tabId");
    await expect(
      browser.chain(
        Array.from({ length: 101 }, () => ({
          action: "title",
          params: { tabId: 4 },
        })),
      ),
    ).rejects.toThrow("at most 100");
  });

  it("allows network observation but not response rewriting or cookie reads", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { completed: 1 },
    }));
    const browser = installBrowserWorkerApi(callBrowser);

    const observations = [
      { action: "har_start", params: { tabId: 4 } },
      { action: "har_stop", params: { tabId: 4 } },
      { action: "requests", params: { tabId: 4, filter: "/api/" } },
      { action: "responsebody", params: { tabId: 4, url: "/api/carts" } },
    ];
    for (const step of observations) {
      await expect(browser.chain([step])).resolves.toBeDefined();
    }

    // Traffic capture must not imply the ability to forge responses or read
    // raw session credentials.
    for (const action of ["route", "unroute", "cookies_get", "cookies_set"]) {
      await expect(
        browser.chain([{ action, params: { tabId: 4 } }]),
      ).rejects.toThrow("unsupported action");
    }

    await expect(
      browser.chain([{ action: "har_stop", params: { tabId: 4, bogus: 1 } }]),
    ).rejects.toThrow();
  });

  it("finalizes owned tabs with explicit handoff statuses", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: { closedTabIds: [3], releasedTabIds: [1, 2] },
    }));
    const browser = installBrowserWorkerApi(callBrowser);
    const first = browser.tabs.get(1);
    const second = browser.tabs.get(2);

    await browser.tabs.finalize([first, { tab: second, status: "handoff" }]);

    expect(callBrowser).toHaveBeenCalledWith("command", [
      "finalize_tabs",
      {
        keep: [
          { tabId: 1, status: "deliverable" },
          { tabId: 2, status: "handoff" },
        ],
      },
    ]);
  });

  it("rejects RegExp selector inputs before transport", async () => {
    const callBrowser = vi.fn<BrowserWorkerCall>(async () => ({
      success: true,
      data: {},
    }));
    const playwright =
      installBrowserWorkerApi(callBrowser).tabs.get(1).playwright;

    expect(() => playwright.getByText(/unsafe/ as unknown as string)).toThrow(
      "does not support RegExp",
    );
    expect(callBrowser).not.toHaveBeenCalled();
  });
});
