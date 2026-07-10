import { describe, expect, it, vi } from "vitest";

import {
  createSkyClient,
  type AuthorizeApp,
  type SkyAction,
} from "../../../../../runtime/kernel/computer-use/client.js";
import type {
  ComputerUseAppPolicy,
  ComputerUseRequest,
  ComputerUseTarget,
} from "../../../../../runtime/kernel/computer-use/contract.js";
import type { ComputerUseSession } from "../../../../../runtime/kernel/computer-use/session.js";

const envelope = (request: ComputerUseRequest) => ({
  schemaVersion: request.schemaVersion,
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const targetLabel = (target: ComputerUseTarget) =>
  target.type === "app"
    ? target.app
    : (target.app ?? `window-id:${target.windowId}`);

const policyFor = (target: ComputerUseTarget): ComputerUseAppPolicy => {
  const label = targetLabel(target);
  const normalized = label.toLocaleLowerCase();
  const isNotes = normalized === "notes" || normalized === "com.apple.notes";
  return {
    bundleIdentifier: isNotes ? "com.apple.Notes" : `test.${normalized}`,
    displayName: isNotes ? "Notes" : label,
    decision: "allowed",
    allowPersistentApproval: true,
  };
};

const createInjectedSession = (
  options: {
    policy?: (target: ComputerUseTarget) => ComputerUseAppPolicy;
    state?: (
      request: Extract<ComputerUseRequest, { type: "get_app_state" }>,
    ) => {
      app: string;
      text: string;
      screenshot: { type: "image"; url: string } | null;
      instructions?: string;
    };
  } = {},
) => {
  const requests: ComputerUseRequest[] = [];
  const request = vi.fn(async (typedRequest: ComputerUseRequest) => {
    requests.push(typedRequest);
    switch (typedRequest.type) {
      case "list_apps":
        return { ...envelope(typedRequest), type: "list_apps", text: "Notes" };
      case "list_windows":
        return {
          ...envelope(typedRequest),
          type: "list_windows",
          text: "Notes [window-id=44]",
        };
      case "resolve_target":
        return {
          ...envelope(typedRequest),
          type: "target_policy",
          policy: (options.policy ?? policyFor)(typedRequest.selector),
        };
      case "get_app_state":
        return {
          ...envelope(typedRequest),
          type: "app_state",
          state:
            options.state?.(typedRequest) ??
            ({
              app: targetLabel(typedRequest.target),
              text: "<app_state>fresh ids</app_state>",
              screenshot: null,
            } as const),
        };
      case "action":
        return {
          ...envelope(typedRequest),
          type: "action",
          receipt: {
            type: "action",
            action: typedRequest.command.action.type,
            target: typedRequest.command.target,
            status: "accepted",
            deferred: true,
          },
        };
      case "batch":
        return {
          ...envelope(typedRequest),
          type: "batch",
          receipt: {
            type: "batch",
            receipts: typedRequest.commands.map((command) => ({
              type: "action" as const,
              action: command.action.type,
              target: command.target,
              status: "accepted" as const,
              deferred: true,
            })),
          },
        };
    }
  });
  return {
    requests,
    session: { request } satisfies ComputerUseSession,
  };
};

describe("typed Sky computer-use client", () => {
  it("submits one background batch request and authorizes a canonical app once", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => true);
    const sky = createSkyClient({
      sessionId: "general-task-agent-1",
      session,
      authorizeApp,
    });
    const actions: SkyAction[] = [
      {
        type: "click",
        app: "Notes",
        element_index: 12,
        mouse_button: "right",
        click_count: 2,
      },
      {
        type: "set_value",
        app: "Notes",
        element_index: 8,
        value: "hello world",
      },
      { type: "type_text", app: "Notes", text: "more text" },
    ];

    await expect(sky.batch(actions)).resolves.toHaveLength(3);

    expect(requests.map((request) => request.type)).toEqual([
      "resolve_target",
      "batch",
    ]);
    const batch = requests[1];
    expect(batch).toMatchObject({
      type: "batch",
      execution: "background",
      schemaVersion: 1,
      protocolVersion: "1.0",
      sessionId: "general-task-agent-1",
      commands: [
        {
          target: { type: "app", app: "Notes" },
          action: {
            type: "click_element",
            elementId: "12",
            mouseButton: "right",
            clickCount: 2,
          },
        },
        {
          action: {
            type: "set_value",
            elementId: "8",
            value: "hello world",
          },
        },
        { action: { type: "type_text", text: "more text" } },
      ],
    });
    expect(JSON.stringify(batch)).not.toMatch(
      /argv|--raise|foreground|defer-observation|stdout/i,
    );
    expect(authorizeApp).toHaveBeenCalledOnce();
    expect(authorizeApp).toHaveBeenCalledWith(
      expect.objectContaining({ bundleIdentifier: "com.apple.Notes" }),
      expect.objectContaining({ selector: { type: "app", app: "Notes" } }),
    );
  });

  it("encodes every strict action variant without foreground controls", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({
      sessionId: "session-1",
      session,
      authorizeApp: async () => true,
    });

    await sky.click({ app: "Notes", x: 10, y: 20 });
    await sky.drag({
      app: "Notes",
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    });
    await sky.perform_secondary_action({
      app: "Notes",
      element_index: 7,
      action: "showMenu",
    });
    await sky.press_key({ app: "Notes", key: "ENTER" });
    await sky.scroll({
      app: "Notes",
      element_index: 9,
      scroll_y: -500,
      pages: 2,
    });
    await sky.select_text({
      app: "Notes",
      element_index: 4,
      text: "needle",
      prefix: "before",
      suffix: "after",
      selection_type: "cursor-after",
    });

    const actionRequests = requests.filter(
      (request): request is Extract<ComputerUseRequest, { type: "action" }> =>
        request.type === "action",
    );
    expect(actionRequests.map((request) => request.command.action)).toEqual([
      {
        type: "click_point",
        point: { x: 10, y: 20 },
        mouseButton: "left",
        clickCount: 1,
      },
      { type: "drag", from: { x: 1, y: 2 }, to: { x: 5, y: 6 } },
      {
        type: "perform_secondary_action",
        elementId: "7",
        action: "showMenu",
      },
      { type: "press_key", key: "ENTER" },
      { type: "scroll", elementId: "9", direction: "up", pages: 2 },
      {
        type: "select_text",
        elementId: "4",
        text: "needle",
        prefix: "before",
        suffix: "after",
        selectionType: "cursor-after",
      },
    ]);
    for (const request of actionRequests) {
      expect(request.execution).toBe("background");
      expect(JSON.stringify(request.command.action)).not.toMatch(
        /raise|foreground|allowHid/i,
      );
    }
  });

  it("caches only callback-approved canonical bundle identifiers", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => true);
    const sky = createSkyClient({
      sessionId: "session-policy",
      session,
      authorizeApp,
    });

    await sky.click({ app: "Notes", element_index: 1 });
    await sky.get_app_state({ app: "com.apple.Notes" });
    await sky.type_text({ app: "Calculator", text: "1+1" });

    expect(
      requests.filter((request) => request.type === "resolve_target"),
    ).toHaveLength(3);
    expect(authorizeApp).toHaveBeenCalledTimes(2);
    expect(
      authorizeApp.mock.calls.map(([policy]) => policy.bundleIdentifier),
    ).toEqual(["com.apple.Notes", "test.calculator"]);
  });

  it("authorizes each distinct canonical batch app once before one batch request", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => true);
    const sky = createSkyClient({
      sessionId: "session-batch-policy",
      session,
      authorizeApp,
    });

    await sky.batch([
      { type: "click", app: "Notes", element_index: 1 },
      {
        type: "set_value",
        app: "com.apple.Notes",
        element_index: 2,
        value: "x",
      },
      { type: "press_key", app: "Calculator", key: "ENTER" },
    ]);

    expect(
      requests.filter((request) => request.type === "resolve_target"),
    ).toHaveLength(3);
    expect(authorizeApp).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "batch")).toHaveLength(
      1,
    );
    expect(requests.at(-1)?.type).toBe("batch");
  });

  it("passes typed images through and delivers instructions once per canonical app", async () => {
    const { session } = createInjectedSession({
      state: (request) => ({
        app: targetLabel(request.target),
        text: "<app_state>fresh ids</app_state>",
        screenshot: {
          type: "image",
          url: "file:///tmp/state%20image.png",
        },
        instructions: "Use the app's Save button.",
      }),
    });
    const sky = createSkyClient({
      sessionId: "session-state",
      session,
      authorizeApp: async () => true,
    });

    const first = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
      disable_diff: true,
    });
    const second = await sky.get_app_state({ app: "com.apple.Notes" });

    expect(first).toEqual({
      app: "Notes",
      screenshot: { url: "file:///tmp/state%20image.png" },
      text: expect.stringContaining("<app_specific_instructions>"),
    });
    expect(first.text).toContain("Use the app's Save button.");
    expect(first.text).toContain("fresh ids");
    expect(second.text).toBe("<app_state>fresh ids</app_state>");
  });

  it("supports list operations and window selectors as typed requests", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({ sessionId: "session-window", session });

    await expect(sky.list_apps()).resolves.toBe("Notes");
    await expect(sky.list_windows()).resolves.toBe("Notes [window-id=44]");
    await sky.click({ app: "Notes", window_id: 44, element_index: 3 });

    expect(requests.map((request) => request.type)).toEqual([
      "list_apps",
      "list_windows",
      "resolve_target",
      "action",
    ]);
    expect(requests[2]).toMatchObject({
      type: "resolve_target",
      selector: { type: "window", app: "Notes", windowId: "44" },
    });
  });

  it("rejects forbidden, denied, and ambiguous operations before dispatch", async () => {
    const { requests, session } = createInjectedSession({
      policy: (target) => ({
        ...policyFor(target),
        decision:
          targetLabel(target) === "Keychain Access" ? "forbidden" : "denied",
      }),
    });
    const sky = createSkyClient({ sessionId: "session-denied", session });

    await expect(
      sky.press_key({ app: "Keychain Access", key: "ENTER" }),
    ).rejects.toThrow("forbidden by computer-use policy");
    await expect(sky.click({ app: "Notes", element_index: 1 })).rejects.toThrow(
      "denied by computer-use policy",
    );
    await expect(
      sky.click({ app: "Notes", element_index: 1, x: 1, y: 2 }),
    ).rejects.toThrow("either element_index or x/y");
    await expect(
      sky.drag({ app: "Notes", path: [{ x: 1, y: 2 }] }),
    ).rejects.toThrow("at least two points");

    expect(
      requests.filter((request) => request.type === "action"),
    ).toHaveLength(0);
  });

  it("does not cache callback denials", async () => {
    const { session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => false);
    const sky = createSkyClient({
      sessionId: "session-callback-denied",
      session,
      authorizeApp,
    });

    await expect(sky.click({ app: "Notes", element_index: 1 })).rejects.toThrow(
      "authorization denied",
    );
    await expect(
      sky.click({ app: "com.apple.Notes", element_index: 2 }),
    ).rejects.toThrow("authorization denied");
    expect(authorizeApp).toHaveBeenCalledTimes(2);
  });
});
