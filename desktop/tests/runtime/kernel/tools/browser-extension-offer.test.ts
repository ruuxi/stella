import { beforeEach, describe, expect, it } from "vitest";

import {
  isBrowserExtensionFailure,
  maybeOfferBrowserExtensionConnect,
  resetBrowserExtensionOfferGate,
} from "../../../../../runtime/kernel/tools/browser-extension-offer.js";
import type { ToolResult } from "../../../../../runtime/kernel/tools/types.js";

const EXTENSION_ERROR =
  "Error: Extension not connected. Install the Stella Browser Bridge extension and connect it.";

const execResult = (output: string, running = false): ToolResult => {
  const payload = { output, running, exit_code: running ? null : 1 };
  return { result: payload, details: payload };
};

const payloadOf = (result: ToolResult) =>
  result.result as { output: string; note?: string };

beforeEach(() => {
  resetBrowserExtensionOfferGate();
});

describe("isBrowserExtensionFailure", () => {
  it("matches completed stella-browser commands with the extension error", () => {
    expect(
      isBrowserExtensionFailure("stella-browser navigate https://x.com", {
        running: false,
        output: EXTENSION_ERROR,
      }),
    ).toBe(true);
  });

  it("ignores non stella-browser commands", () => {
    expect(
      isBrowserExtensionFailure("curl https://example.com", {
        running: false,
        output: EXTENSION_ERROR,
      }),
    ).toBe(false);
  });

  it("ignores still-running sessions and unrelated failures", () => {
    expect(
      isBrowserExtensionFailure("stella-browser snapshot", {
        running: true,
        output: EXTENSION_ERROR,
      }),
    ).toBe(false);
    expect(
      isBrowserExtensionFailure("stella-browser snapshot", {
        running: false,
        output: "Error: navigation timed out",
      }),
    ).toBe(false);
  });

  it("ignores the transient service-worker reconnect error", () => {
    expect(
      isBrowserExtensionFailure("stella-browser click ref=12", {
        running: false,
        output:
          "Extension connection is dead (service worker terminated). The extension will auto-reconnect shortly — try again.",
      }),
    ).toBe(false);
  });
});

describe("maybeOfferBrowserExtensionConnect", () => {
  it("re-runs the command once after the user connects", async () => {
    let reran = 0;
    const retried = execResult("page snapshot ok");
    const result = await maybeOfferBrowserExtensionConnect({
      result: execResult(EXTENSION_ERROR),
      command: "stella-browser snapshot",
      requestConnect: async () => ({ ok: true, status: "connected" }),
      rerun: async () => {
        reran += 1;
        return retried;
      },
    });
    expect(reran).toBe(1);
    expect(payloadOf(result).output).toBe("page snapshot ok");
    expect(payloadOf(result).note).toMatch(/re-run automatically/);
  });

  it("annotates a decline and enters a cool-down without re-running", async () => {
    let offers = 0;
    let now = 1_000_000;
    const request = async () => {
      offers += 1;
      return { ok: false as const, reason: "declined" as const };
    };
    const first = await maybeOfferBrowserExtensionConnect({
      result: execResult(EXTENSION_ERROR),
      command: "stella-browser snapshot",
      requestConnect: request,
      rerun: async () => {
        throw new Error("must not re-run on decline");
      },
      now: () => now,
    });
    expect(offers).toBe(1);
    expect(payloadOf(first).note).toMatch(/declined/);
    expect(payloadOf(first).note).toMatch(/do not re-offer/i);

    // Within the cool-down the offer is suppressed entirely.
    now += 60_000;
    const second = await maybeOfferBrowserExtensionConnect({
      result: execResult(EXTENSION_ERROR),
      command: "stella-browser snapshot",
      requestConnect: request,
      rerun: async () => {
        throw new Error("must not re-run in cool-down");
      },
      now: () => now,
    });
    expect(offers).toBe(1);
    expect(payloadOf(second).note).toMatch(/recently declined/);
  });

  it("returns the raw result when the host hop is unsupported", async () => {
    const original = execResult(EXTENSION_ERROR);
    const result = await maybeOfferBrowserExtensionConnect({
      result: original,
      command: "stella-browser snapshot",
      requestConnect: async () => ({ ok: false, reason: "unsupported" }),
      rerun: async () => {
        throw new Error("must not re-run");
      },
    });
    expect(result).toBe(original);
  });

  it("passes unrelated results through untouched", async () => {
    const original = execResult("hello world");
    const result = await maybeOfferBrowserExtensionConnect({
      result: original,
      command: "echo hello world",
      requestConnect: async () => {
        throw new Error("must not offer");
      },
      rerun: async () => {
        throw new Error("must not re-run");
      },
    });
    expect(result).toBe(original);
  });
});
