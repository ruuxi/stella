import { mkdtempSync } from "node:fs";
import { rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearConnectorDecline,
  getConnectorDecline,
  listConnectorDeclines,
  recordConnectorDecline,
} from "../../../../../runtime/kernel/connectors/connect-preferences.js";
import {
  discoverConnectors,
  scoreConnectorMatch,
} from "../../../../../runtime/kernel/connectors/discovery.js";
import { enableNativeConnector } from "../../../../../runtime/kernel/connectors/native-integrations.js";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-discovery-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("connect-preferences", () => {
  it("records, reads, and clears declines", async () => {
    const root = makeRoot();
    expect(await getConnectorDecline(root, "gmail")).toBeNull();

    const first = await recordConnectorDecline(root, "gmail");
    expect(first.count).toBe(1);
    expect(await getConnectorDecline(root, "gmail")).toMatchObject({
      count: 1,
    });

    const second = await recordConnectorDecline(root, "gmail");
    expect(second.count).toBe(2);
    expect(Object.keys(await listConnectorDeclines(root))).toEqual(["gmail"]);

    await clearConnectorDecline(root, "gmail");
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
  });

  it("survives a corrupt preferences file", async () => {
    const root = makeRoot();
    await mkdir(path.join(root, "connectors"), { recursive: true });
    await writeFile(
      path.join(root, "connectors", "connect-preferences.json"),
      "not-json",
      "utf-8",
    );
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
    await recordConnectorDecline(root, "gmail");
    expect(await getConnectorDecline(root, "gmail")).toMatchObject({
      count: 1,
    });
  });

  it("is cleared when the integration is enabled", async () => {
    const root = makeRoot();
    await recordConnectorDecline(root, "gmail");
    await enableNativeConnector(root, "gmail", "store");
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
  });
});

describe("scoreConnectorMatch", () => {
  it("ranks exact id/name hits above substring hits", () => {
    const tokens = ["gmail"];
    const exact = scoreConnectorMatch(tokens, {
      id: "gmail",
      name: "Gmail",
      description: "Search and send Gmail messages.",
    });
    const substringOnly = scoreConnectorMatch(tokens, {
      id: "mailchimp",
      name: "Mailchimp",
      description: "Email marketing, not gmail.",
    });
    expect(exact).toBeGreaterThan(substringOnly);
    expect(substringOnly).toBeGreaterThan(0);
  });

  it("matches multi-word queries against name tokens and category", () => {
    const score = scoreConnectorMatch(["calendar", "events"], {
      id: "googlecalendar",
      name: "Google Calendar",
      category: "scheduling & booking",
      description: "List calendars and create events.",
    });
    expect(score).toBeGreaterThan(0);
  });

  it("returns zero when nothing matches", () => {
    expect(
      scoreConnectorMatch(["notion"], {
        id: "gmail",
        name: "Gmail",
        description: "Email things.",
      }),
    ).toBe(0);
  });
});

describe("discoverConnectors", () => {
  it("finds native catalog entries with enabled + declined state", async () => {
    const root = makeRoot();
    await recordConnectorDecline(root, "googledrive");

    const matches = await discoverConnectors(root, "gmail", {
      enabledNativeIds: new Set(["gmail"]),
    });
    expect(matches[0]).toMatchObject({
      id: "gmail",
      kind: "native",
      enabled: true,
      declined: false,
    });

    const driveMatches = await discoverConnectors(root, "google drive files", {
      enabledNativeIds: new Set(),
    });
    const drive = driveMatches.find((match) => match.id === "googledrive");
    expect(drive).toMatchObject({ enabled: false, declined: true });
  });

  it("includes imported MCP connectors from state", async () => {
    const root = makeRoot();
    await mkdir(path.join(root, "connectors"), { recursive: true });
    await writeFile(
      path.join(root, "connectors", "commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "linear-mcp",
            displayName: "Linear",
            description: "Issue tracking via Linear MCP.",
            transport: "streamable_http",
            url: "https://mcp.linear.app/sse",
            auth: { type: "oauth", tokenKey: "linear" },
          },
        ],
      }),
      "utf-8",
    );
    const matches = await discoverConnectors(root, "linear issues", {
      enabledNativeIds: new Set(),
    });
    const linear = matches.find((match) => match.id === "linear-mcp");
    expect(linear).toMatchObject({ kind: "mcp", enabled: true });
  });

  it("respects a server catalog override for backend integrations", async () => {
    const root = makeRoot();
    const matches = await discoverConnectors(root, "outlook payments", {
      enabledNativeIds: new Set(),
      catalogOverride: [
        {
          id: "outlook",
          name: "Outlook",
          category: "email",
          auth: ["OAUTH2"],
          catalogToolCount: 12,
          availability: "ready",
          provider: "backend-composio",
          description: "Read and send Outlook mail.",
          connectable: true,
          backendConnector: { type: "composio", toolkit: "OUTLOOK" },
        },
      ],
    });
    expect(matches[0]).toMatchObject({
      id: "outlook",
      kind: "native",
      connectable: true,
      enabled: false,
    });
  });

  it("returns an empty list for an empty query", async () => {
    const root = makeRoot();
    expect(
      await discoverConnectors(root, "  ", { enabledNativeIds: new Set() }),
    ).toEqual([]);
  });
});
