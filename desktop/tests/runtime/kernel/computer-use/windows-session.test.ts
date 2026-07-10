import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  type ComputerUseAction,
  type ComputerUseRequest,
} from "../../../../../runtime/kernel/computer-use/contract.js";
import { executeComputerUseRequest } from "../../../../../runtime/kernel/computer-use/session.js";
import {
  createWindowsComputerUseSession,
  type WindowsComputerHelperRequest,
} from "../../../../../runtime/kernel/computer-use/windows-session.js";
import { runWithComputerExecutionContext } from "../../../../../runtime/kernel/computer-use/execution-context.js";
import type {
  WinHelperRequest,
  WinSnapshot,
} from "../../../../../runtime/kernel/cli/stella-computer-windows.js";

const envelope = (requestId: string, sessionId = "windows-session") => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId,
  sessionId,
});

const snapshot = (overrides: Partial<WinSnapshot> = {}): WinSnapshot => ({
  app: {
    name: "Spotify.exe",
    bundleIdentifier: "Spotify.exe",
    pid: 321,
  },
  windowId: 654,
  windowTitle: "Spotify",
  windowBounds: { x: 10, y: 20, width: 900, height: 700 },
  screenshotPngBase64: Buffer.from("png-bytes").toString("base64"),
  screenshot: { widthPx: 900, heightPx: 700 },
  treeLines: ['[12] textbox "Search"', '[19] button "Play"'],
  elements: [
    { index: 12, name: "Search", controlType: "Edit" },
    { index: 19, name: "Play", controlType: "Button" },
  ],
  appInstructions: "Prefer the Search textbox for exact queries.",
  ...overrides,
});

const withStateRoot = async <T>(operation: () => Promise<T>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-windows-session-"));
  try {
    const result = await runWithComputerExecutionContext(
      { env: { ...process.env, STELLA_DATA_DIR: root } },
      operation,
    );
    return { value: result.value, root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

describe("Windows production ComputerUseSession", () => {
  it("maps list, canonical target policy, and state directly to typed helper requests", async () => {
    const calls: WinHelperRequest[] = [];
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        calls.push(operation);
        if (operation.tool === "list_apps") {
          return { ok: true, text: "Spotify.exe\nBrave.exe" };
        }
        if (operation.tool === "list_windows") {
          return {
            ok: true,
            windows: [
              {
                pid: 321,
                windowId: 654,
                app: "Spotify.exe",
                title: "Spotify",
              },
            ],
          };
        }
        return { ok: true, snapshot: snapshot() };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { value, root } = await withStateRoot(async () => {
      const apps = await executeComputerUseRequest(session, {
        ...envelope("apps"),
        type: "list_apps",
      });
      const windows = await executeComputerUseRequest(session, {
        ...envelope("windows"),
        type: "list_windows",
      });
      const policy = await executeComputerUseRequest(session, {
        ...envelope("policy"),
        type: "resolve_target",
        selector: { type: "app", app: "spotify" },
      });
      const state = await executeComputerUseRequest(session, {
        ...envelope("state"),
        type: "get_app_state",
        target: { type: "window", app: "spotify", windowId: "654" },
        screenshotPolicy: "auto",
        disableDiff: false,
      });
      return { apps, windows, policy, state };
    });

    expect(value.apps.text).toBe("Spotify.exe\nBrave.exe");
    expect(value.windows.text).toContain("target=hwnd:654");
    expect(value.policy.policy).toEqual({
      bundleIdentifier: "Spotify.exe",
      displayName: "Spotify.exe",
      decision: "allowed",
      allowPersistentApproval: true,
    });
    expect(value.state.state).toMatchObject({
      app: "Spotify.exe",
      text: expect.stringContaining('[12] textbox "Search"'),
      instructions: "Prefer the Search textbox for exact queries.",
      screenshot: {
        type: "image",
        mimeType: "image/png",
        width: 900,
        height: 700,
      },
    });
    expect(value.state.state.screenshot?.url).toMatch(/^file:/);
    expect(
      existsSync(
        path.join(
          root,
          "stella-computer",
          "sessions",
          "windows-session",
          "windows-targets",
          "window-654",
          "last-screenshot.png",
        ),
      ),
    ).toBe(true);
    expect(calls).toEqual([
      { tool: "list_apps" },
      { tool: "list_windows" },
      {
        tool: "get_app_state",
        app: "spotify",
        windowId: undefined,
        screenshot_policy: "never",
      },
      {
        tool: "get_app_state",
        app: "spotify",
        windowId: 654,
        screenshot_policy: "auto",
      },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it.each<{
    name: string;
    action: ComputerUseAction;
    expected: Partial<WinHelperRequest>;
  }>([
    {
      name: "element click",
      action: {
        type: "click_element",
        elementId: "19",
        mouseButton: "left",
        clickCount: 2,
      },
      expected: {
        tool: "click",
        element: { index: 19, name: "Play", controlType: "Button" },
        mouse_button: "left",
        click_count: 2,
      },
    },
    {
      name: "semantic text selection",
      action: {
        type: "select_text",
        elementId: "12",
        text: "exact",
        prefix: "before",
        suffix: "after",
        selectionType: "cursor-after",
      },
      expected: {
        tool: "select_text",
        text: "exact",
        prefix: "before",
        suffix: "after",
        selection: "cursor-after",
      },
    },
    {
      name: "background typing",
      action: { type: "type_text", text: "temporary query" },
      expected: { tool: "type_text", text: "temporary query" },
    },
    {
      name: "screenshot drag",
      action: {
        type: "drag",
        from: { x: 11, y: 22 },
        to: { x: 33, y: 44 },
      },
      expected: {
        tool: "drag",
        from_x: 11,
        from_y: 22,
        to_x: 33,
        to_y: 44,
        screenshot_width: 900,
        screenshot_height: 700,
      },
    },
  ])(
    "maps $name without argv/stdout translation",
    async ({ action, expected }) => {
      const operations: WinHelperRequest[] = [];
      const requestHelper: WindowsComputerHelperRequest = vi.fn(
        async (_sessionId, operation) => {
          operations.push(operation);
          if (operation.tool === "get_app_state") {
            return { ok: true, snapshot: snapshot() };
          }
          return {
            ok: true,
            deferred: true,
            revision: 8,
            receipt: {
              route: "uia.test",
              dispatch: "background",
              background_safe: true,
            },
          };
        },
      );
      const session = createWindowsComputerUseSession({ requestHelper });
      const { value, root } = await withStateRoot(async () => {
        await executeComputerUseRequest(session, {
          ...envelope("observe"),
          type: "get_app_state",
          target: { type: "app", app: "spotify" },
          screenshotPolicy: "never",
          disableDiff: false,
        });
        return await executeComputerUseRequest(session, {
          ...envelope("action"),
          type: "action",
          execution: "background",
          command: {
            target: { type: "app", app: "spotify" },
            action,
          },
        });
      });

      expect(operations[1]).toMatchObject({
        ...expected,
        app: "spotify",
        windowId: 654,
        dispatch: "background",
        defer_observation: true,
        screenshot_policy: "auto",
      });
      expect(value.receipt).toMatchObject({
        action: action.type,
        status: "accepted",
        deferred: true,
        details: {
          revision: 8,
          deferred: true,
        },
      });
      rmSync(root, { recursive: true, force: true });
    },
  );

  it("sends a typed batch as exactly one helper request and maps every native result", async () => {
    const operations: Parameters<WindowsComputerHelperRequest>[1][] = [];
    let active = 0;
    let maxActive = 0;
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        operations.push(operation);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (operation.tool === "get_app_state") {
          return { ok: true, snapshot: snapshot() };
        }
        if ("commands" in operation) {
          return {
            ok: true,
            completed: operation.commands.length,
            results: operation.commands.map((_command, index) => ({
              index,
              ok: true,
              result: {
                ok: true,
                deferred: true,
                revision: index + 10,
              },
            })),
          };
        }
        return { ok: true, deferred: true, revision: operations.length };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { value, root } = await withStateRoot(async () => {
      await executeComputerUseRequest(session, {
        ...envelope("observe"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      const request: ComputerUseRequest = {
        ...envelope("batch"),
        type: "batch",
        execution: "background",
        commands: [
          {
            target: { type: "app", app: "spotify" },
            action: { type: "press_key", key: "CTRL+L" },
          },
          {
            target: { type: "app", app: "spotify" },
            action: { type: "type_text", text: "query" },
          },
        ],
      };
      return await executeComputerUseRequest(session, request);
    });

    expect(value.receipt.receipts).toHaveLength(2);
    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({
      tool: "batch",
      commands: [
        {
          tool: "press_key",
          key: "CTRL+L",
          dispatch: "background",
          defer_observation: true,
        },
        {
          tool: "type_text",
          text: "query",
          dispatch: "background",
          defer_observation: true,
        },
      ],
    });
    expect(value.receipt.receipts).toMatchObject([
      { action: "press_key", details: { revision: 10 } },
      { action: "type_text", details: { revision: 11 } },
    ]);
    expect(maxActive).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("surfaces the first failed native batch result without issuing more helper requests", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        if (operation.tool === "get_app_state") {
          return { ok: true, snapshot: snapshot() };
        }
        return {
          ok: false,
          completed: 1,
          error: "strict background dispatch failed",
          results: [
            {
              index: 0,
              ok: true,
              result: { ok: true, deferred: true, revision: 10 },
            },
            {
              index: 1,
              ok: false,
              error: "strict background dispatch failed",
            },
          ],
        };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { root } = await withStateRoot(async () => {
      await executeComputerUseRequest(session, {
        ...envelope("observe-failed-batch"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      await expect(
        executeComputerUseRequest(session, {
          ...envelope("failed-batch"),
          type: "batch",
          execution: "background",
          commands: [
            {
              target: { type: "app", app: "spotify" },
              action: { type: "press_key", key: "CTRL+L" },
            },
            {
              target: { type: "app", app: "spotify" },
              action: { type: "type_text", text: "query" },
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "windows_session_failed",
        message: "strict background dispatch failed",
      });
    });

    expect(requestHelper).toHaveBeenCalledTimes(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns typed errors for unresolved targets and missing observed state", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(async () => ({
      ok: false,
      error: "No matching process",
    }));
    const session = createWindowsComputerUseSession({ requestHelper });

    await expect(
      executeComputerUseRequest(session, {
        ...envelope("missing-policy"),
        type: "resolve_target",
        selector: { type: "app", app: "missing" },
      }),
    ).rejects.toMatchObject({
      code: "windows_target_resolution_failed",
      message: "No matching process",
    });
    await expect(
      executeComputerUseRequest(session, {
        ...envelope("missing-state"),
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: "missing" },
          action: { type: "type_text", text: "no-op" },
        },
      }),
    ).rejects.toMatchObject({
      code: "windows_session_failed",
      message: expect.stringContaining("Call get_app_state"),
    });
  });
});
