import { describe, expect, it } from "vitest";

import {
  parseComputerUseRequest,
  parseComputerUseResponse,
} from "../../../../../runtime/kernel/computer-use/contract.js";

const envelope = {
  schemaVersion: 1,
  protocolVersion: "1.0",
  requestId: "request-1",
  sessionId: "session-1",
} as const;

describe("computer-use contract", () => {
  it("round-trips strict JSON-safe versioned requests", () => {
    const request = {
      ...envelope,
      type: "batch",
      execution: "background",
      commands: [
        {
          target: { type: "app", app: "Notes" },
          action: {
            type: "click_element",
            elementId: "12",
            mouseButton: "left",
            clickCount: 1,
          },
        },
      ],
    };

    expect(
      parseComputerUseRequest(JSON.parse(JSON.stringify(request))),
    ).toEqual(request);
  });

  it("rejects version drift, non-JSON values, foreground mode, and mixed variants", () => {
    expect(() =>
      parseComputerUseRequest({
        ...envelope,
        schemaVersion: 2,
        type: "list_apps",
      }),
    ).toThrow("schemaVersion");
    expect(() =>
      parseComputerUseRequest({
        ...envelope,
        type: "action",
        execution: "foreground",
        command: {
          target: { type: "app", app: "Notes" },
          action: { type: "press_key", key: "ENTER" },
        },
      }),
    ).toThrow("background");
    expect(() =>
      parseComputerUseRequest({
        ...envelope,
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: "Notes" },
          action: {
            type: "click_element",
            elementId: "1",
            mouseButton: "left",
            clickCount: 1,
            point: { x: 1, y: 2 },
          },
        },
      }),
    ).toThrow("unsupported field point");
    expect(() =>
      parseComputerUseRequest({
        ...envelope,
        type: "list_apps",
        unsafe: undefined,
      }),
    ).toThrow("not JSON-safe");
  });

  it("validates the canonical target policy operation", () => {
    expect(
      parseComputerUseResponse({
        ...envelope,
        type: "target_policy",
        policy: {
          bundleIdentifier: "com.apple.Notes",
          displayName: "Notes",
          appPath: "/System/Applications/Notes.app",
          decision: "denied",
          allowPersistentApproval: true,
          risk: "Can modify notes",
          warningSubtitle: "Allow this app for the session?",
        },
      }),
    ).toMatchObject({
      type: "target_policy",
      policy: { bundleIdentifier: "com.apple.Notes", decision: "denied" },
    });
  });

  it("rejects malformed receipt and image response shapes", () => {
    expect(() =>
      parseComputerUseResponse({
        ...envelope,
        type: "action",
        receipt: {
          type: "action",
          action: "press_key",
          target: { type: "app", app: "Notes" },
          status: "completed",
          deferred: false,
          foreground: true,
        },
      }),
    ).toThrow("unsupported field foreground");
    expect(() =>
      parseComputerUseResponse({
        ...envelope,
        type: "app_state",
        state: {
          app: "Notes",
          text: "state",
          screenshot: { type: "image", url: "file:///tmp/state.png", width: 0 },
        },
      }),
    ).toThrow("positive integer");
  });
});
