import { describe, expect, it, vi } from "vitest";

import {
  createSkyClient,
  type SkyAction,
} from "../../../../../runtime/kernel/computer-use/client.js";
import type {
  ComputerCommandRequest,
  ComputerCommandResult,
} from "../../../../../runtime/kernel/computer-use/command-runner.js";

const ok = (stdout = '{"ok":true}') => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const commandArgs = (request: ComputerCommandRequest) => request.args.slice(3);

describe("sky computer-use client", () => {
  it("encodes deferred actions and batches them through the scoped CLI session", async () => {
    const requests: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      return ok();
    });
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
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
    await sky.batch(actions);

    expect(requests[0]?.args.slice(0, 3)).toEqual([
      "/runtime/stella-computer.js",
      "--session",
      "general-task-agent-1",
    ]);
    expect(commandArgs(requests[0]!)).toEqual([
      "click",
      "12",
      "--app",
      "Notes",
      "--mouse-button",
      "right",
      "--click-count",
      "2",
      "--defer-observation",
      "--json",
    ]);
    expect(commandArgs(requests[1]!)).toEqual([
      "fill",
      "8",
      "hello world",
      "--app",
      "Notes",
      "--defer-observation",
      "--json",
    ]);
    expect(commandArgs(requests[2]!)).toEqual([
      "type",
      "more text",
      "--app",
      "Notes",
      "--allow-hid",
      "--raise",
      "--defer-observation",
      "--json",
    ]);
  });

  it("raises the named app before global HID actions", async () => {
    const requests: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      return ok();
    });
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
    });

    await sky.click({ app: "Brave Browser", x: 10, y: 20 });
    await sky.drag({
      app: "Brave Browser",
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
    });
    await sky.press_key({ app: "Brave Browser", key: "super+t" });
    await sky.type_text({ app: "Brave Browser", text: "about:blank" });

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(commandArgs(request)).toContain("--raise");
      expect(commandArgs(request)).toContain("--defer-observation");
    }
  });

  it("supports Windows window targets and list_windows without changing app targets", async () => {
    const requests: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      return commandArgs(request)[0] === "list-windows"
        ? ok("Notepad [window-id=44]\n")
        : ok();
    });
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
    });

    await expect(sky.list_windows()).resolves.toBe("Notepad [window-id=44]");
    await sky.click({
      app: "Notepad",
      window_id: 44,
      element_index: 3,
    });

    expect(commandArgs(requests[0]!)).toEqual(["list-windows"]);
    expect(commandArgs(requests[1]!)).toContain("--window-id");
    expect(commandArgs(requests[1]!)).toEqual([
      "click",
      "3",
      "--app",
      "Notepad",
      "--window-id",
      "44",
      "--mouse-button",
      "left",
      "--click-count",
      "1",
      "--defer-observation",
      "--json",
    ]);
  });

  it("encodes coordinate, drag, secondary, key, and scroll actions", async () => {
    const requests: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      return ok();
    });
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
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

    expect(requests.map((request) => commandArgs(request)[0])).toEqual([
      "click-screenshot",
      "drag-screenshot",
      "secondary-action",
      "press",
      "scroll",
    ]);
    expect(commandArgs(requests[1]!)).toContain("--allow-hid");
    expect(commandArgs(requests[4]!)).toEqual([
      "scroll",
      "9",
      "up",
      "--app",
      "Notes",
      "--pages",
      "2",
      "--defer-observation",
      "--json",
    ]);
    for (const request of requests) {
      expect(commandArgs(request).slice(-2)).toEqual([
        "--defer-observation",
        "--json",
      ]);
    }
  });

  it("parses normal state output and delivers app instructions once per kernel client", async () => {
    const stateOutput = [
      "<app_specific_instructions>",
      "Use the app's Save button.",
      "</app_specific_instructions>",
      "<app_state>fresh ids</app_state>",
      `[stella-attach-image] 800x600 10KB path=${JSON.stringify("/tmp/state image.png")}`,
      "",
    ].join("\n");
    const runner = vi.fn(
      async (): Promise<ComputerCommandResult> => ok(stateOutput),
    );
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
    });

    const first = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
      disable_diff: true,
    });
    const second = await sky.get_app_state({ app: "Notes" });
    await sky.get_app_state({ app: "Notes", disableDiff: true });

    expect(first).toEqual({
      app: "Notes",
      screenshot: { url: "file:///tmp/state%20image.png" },
      text: expect.stringContaining("<app_specific_instructions>"),
    });
    expect(first.text).toContain("fresh ids");
    expect(second.text).not.toContain("app_specific_instructions");
    expect(commandArgs(runner.mock.calls[0]![0])).toEqual([
      "get-state",
      "--app",
      "Notes",
      "--no-inline-screenshot",
      "--screenshot-policy",
      "always",
      "--disable-diff",
    ]);
    expect(commandArgs(runner.mock.calls[1]![0])).toEqual([
      "get-state",
      "--app",
      "Notes",
      "--no-inline-screenshot",
      "--screenshot-policy",
      "auto",
    ]);
    expect(commandArgs(runner.mock.calls[2]![0])).toEqual([
      "get-state",
      "--app",
      "Notes",
      "--no-inline-screenshot",
      "--screenshot-policy",
      "auto",
      "--disable-diff",
    ]);
  });

  it("maps selection_type internally and surfaces CLI failures", async () => {
    const requests: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      if (requests.length === 2) {
        return {
          exitCode: 1,
          stdout: '{"ok":false,"error":"blocked target"}',
          stderr: "",
        };
      }
      return ok();
    });
    const sky = createSkyClient({
      cliPath: "/runtime/stella-computer.js",
      sessionId: "general-task-agent-1",
      cwd: "/workspace",
      runner,
    });

    await sky.select_text({
      app: "Notes",
      element_index: 4,
      text: "needle",
      selection_type: "cursor-after",
    });
    await expect(
      sky.press_key({ app: "Keychain Access", key: "ENTER" }),
    ).rejects.toThrow("blocked target");
    expect(commandArgs(requests[0]!)).toContain("--selection");
    expect(commandArgs(requests[0]!)).toContain("cursor-after");
  });
});
