import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readCachedServerCatalog,
  writeCachedServerCatalog,
} from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import {
  buildConnectorKeywordIndex,
  getConnectorKeywordIndex,
  matchConnectorsInMessage,
  resetConnectorKeywordIndexCache,
} from "../../../../../runtime/kernel/connectors/keyword-index.js";
import type { NativeConnectorCatalogEntry } from "../../../../../runtime/kernel/connectors/native-integrations.js";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-keyword-index-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  resetConnectorKeywordIndexCache();
});

const composioEntry = (
  id: string,
  name: string,
  overrides: Partial<NativeConnectorCatalogEntry> = {},
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "integrations",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} integration`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
  ...overrides,
});

const fakeCatalog: NativeConnectorCatalogEntry[] = [
  composioEntry("gmail", "Gmail"),
  composioEntry("outlook", "Outlook"),
  composioEntry("googlecalendar", "Google Calendar"),
  composioEntry("notion", "Notion"),
  composioEntry("slack", "Slack"),
  // Generic single-word name: must not become a standalone keyword.
  composioEntry("docs", "Docs"),
];

describe("buildConnectorKeywordIndex + matchConnectorsInMessage", () => {
  const index = buildConnectorKeywordIndex(fakeCatalog);

  it("maps loose synonyms to every matching connector", () => {
    const ids = matchConnectorsInMessage(
      index,
      "Check my email for what I bought last week",
    ).map((entry) => entry.id);
    expect(ids).toContain("gmail");
    expect(ids).toContain("outlook");
  });

  it("matches catalog names as whole phrases", () => {
    const ids = matchConnectorsInMessage(
      index,
      "Add lunch with Sam to my Google Calendar tomorrow",
    ).map((entry) => entry.id);
    expect(ids[0]).toBe("googlecalendar");
  });

  it("matches derived ids/names like notion and slack", () => {
    expect(
      matchConnectorsInMessage(index, "save this page to Notion").map(
        (entry) => entry.id,
      ),
    ).toEqual(["notion"]);
    expect(
      matchConnectorsInMessage(index, "post the summary in slack").map(
        (entry) => entry.id,
      ),
    ).toContain("slack");
  });

  it("does not match ordinary conversation", () => {
    expect(
      matchConnectorsInMessage(index, "what's a good pasta recipe?"),
    ).toEqual([]);
  });

  it("keeps generic words out of the derived keyword set", () => {
    // "docs" is stoplisted as a derived keyword; with no googledocs in this
    // catalog the docs synonym has no valid target either.
    expect(
      matchConnectorsInMessage(index, "read the docs for this library"),
    ).toEqual([]);
  });

  it("requires whole-word matches", () => {
    expect(
      matchConnectorsInMessage(index, "the gmailer tool is unrelated"),
    ).toEqual([]);
  });

  it("drops synonyms whose targets are missing from the catalog", () => {
    const tiny = buildConnectorKeywordIndex([composioEntry("notion", "Notion")]);
    expect(matchConnectorsInMessage(tiny, "check my email")).toEqual([]);
  });
});

describe("getConnectorKeywordIndex (catalog cache sync)", () => {
  it("derives the index from the disk-cached server catalog and rebuilds on refresh", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [composioEntry("linear", "Linear")]);
    const first = await getConnectorKeywordIndex(root);
    expect(
      matchConnectorsInMessage(first, "create a linear issue").map(
        (entry) => entry.id,
      ),
    ).toContain("linear");

    // New catalog fetch lands on disk → the index picks it up.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeCachedServerCatalog(root, [
      composioEntry("linear", "Linear"),
      composioEntry("asana", "Asana"),
    ]);
    const second = await getConnectorKeywordIndex(root);
    expect(
      matchConnectorsInMessage(second, "add it to asana").map(
        (entry) => entry.id,
      ),
    ).toContain("asana");
  });

  it("round-trips the server catalog through the disk cache", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [composioEntry("notion", "Notion")]);
    const cached = await readCachedServerCatalog(root);
    expect(cached?.entries.map((entry) => entry.id)).toEqual(["notion"]);
    expect(cached?.entries[0]?.provider).toBe("backend-composio");
  });
});
