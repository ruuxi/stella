import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const catalogPath = path.join(
  repoRoot,
  "runtime/kernel/connectors/oauth-provider-catalog.ts",
);
const endpoint =
  process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp";
const apiKey = process.env.COMPOSIO_CONSUMER_API_KEY;

const usage = () => {
  console.error(
    [
      "Usage:",
      "  COMPOSIO_CONSUMER_API_KEY=... bun runtime/scripts/recover-composio-oauth-actions.mjs [--apply] [--fill-missing-schemas] [--schemas-only] [--summary] [--schema-limit N] [provider ...]",
      "",
      "--schemas-only skips provider discovery and fetches schemas for existing recovered tool slugs.",
      "When no providers are passed, only catalog entries with no recovered actions are queried.",
    ].join("\n"),
  );
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fillMissingSchemas = args.includes("--fill-missing-schemas");
const schemasOnly = args.includes("--schemas-only");
const summary = args.includes("--summary");
const schemaConcurrency = Number(
  process.env.COMPOSIO_SCHEMA_CONCURRENCY ?? "8",
);
const schemaLimitArgIndex = args.indexOf("--schema-limit");
const schemaLimit =
  schemaLimitArgIndex >= 0
    ? Number(args[schemaLimitArgIndex + 1] ?? "0")
    : Number(process.env.COMPOSIO_SCHEMA_LIMIT ?? "0");
const requestTimeoutMs = Number(
  process.env.COMPOSIO_REQUEST_TIMEOUT_MS ?? "45000",
);
const providerArgs = args.filter(
  (arg) =>
    arg !== "--apply" &&
    arg !== "--fill-missing-schemas" &&
    arg !== "--schemas-only" &&
    arg !== "--summary" &&
    arg !== "--schema-limit" &&
    (schemaLimitArgIndex < 0 || arg !== args[schemaLimitArgIndex + 1]),
);

const excludedProviderIds = new Set([
  "borneo",
  "clockify",
  "discord",
  "discordbot",
  "epic_games",
  "insighto_ai",
  "lodgify",
  "matterport",
  "microsoft_teams",
  "parma",
  "pinecone",
  "recruitee",
  "scheduleonce",
  "sendloop",
  "slack",
  "slackbot",
  "tally",
  "ticketmaster",
  "trello",
  "whatsapp",
  "wix",
  "zoominfo",
]);

const titleFromSlug = (slug) =>
  slug
    .replace(/^[A-Z0-9]+_MCP_/u, "")
    .replace(/^[A-Z0-9]+_/u, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

const readCatalog = async () => {
  const text = await readFile(catalogPath, "utf8");
  const marker =
    "export const OAUTH_PROVIDER_CATALOG: OAuthCatalogProvider[] = ";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("Could not find catalog export.");
  const prefix = text.slice(0, start + marker.length);
  const bodyStart = start + marker.length;
  const end = text.lastIndexOf("\n];");
  if (end < bodyStart) throw new Error("Could not find catalog array end.");
  const arrayText = text.slice(bodyStart, end + 2);
  let catalog;
  try {
    catalog = JSON.parse(arrayText);
  } catch {
    const moduleUrl = pathToFileURL(catalogPath);
    moduleUrl.searchParams.set("t", String(Date.now()));
    const module = await import(moduleUrl.href);
    catalog = JSON.parse(JSON.stringify(module.OAUTH_PROVIDER_CATALOG));
  }
  return {
    prefix,
    suffix: text.slice(end + 2),
    catalog,
  };
};

const parseSseJson = (text) => {
  const messages = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data: ")) continue;
    messages.push(JSON.parse(line.slice("data: ".length)));
  }
  return messages;
};

const fetchComposio = async (body, sessionId) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "x-consumer-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const searchProvider = async (provider) => {
  const sessionId = `stella-catalog-${provider.id}`;
  const response = await fetchComposio(
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "COMPOSIO_SEARCH_TOOLS",
        arguments: {
          queries: [
            {
              use_case: `discover ${provider.name} toolkit tools and schemas for ${provider.description}`,
            },
          ],
          session: { generate_id: true },
          model: "gpt-5.2",
        },
      },
    },
    sessionId,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${provider.id}: Composio MCP request failed ${response.status}`,
    );
  }

  const toolsBySlug = new Map();
  for (const message of parseSseJson(text)) {
    const content = message?.result?.content ?? [];
    for (const item of content) {
      if (item?.type !== "text") continue;
      const payload = JSON.parse(item.text);
      const schemas = payload?.data?.tool_schemas ?? {};
      for (const [slug, schema] of Object.entries(schemas)) {
        toolsBySlug.set(slug, {
          name: slug,
          title: titleFromSlug(slug),
          description:
            typeof schema.description === "string"
              ? schema.description.replace(/\s+/gu, " ").trim()
              : undefined,
          inputSchema:
            schema.input_schema &&
            typeof schema.input_schema === "object" &&
            !Array.isArray(schema.input_schema)
              ? schema.input_schema
              : undefined,
          exactSlug: true,
        });
      }
    }
  }

  return [...toolsBySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const searchExactToolSchema = async (toolName) => {
  const sessionId = `stella-catalog-${toolName.toLowerCase()}`;
  const response = await fetchComposio(
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "COMPOSIO_SEARCH_TOOLS",
        arguments: {
          queries: [
            {
              use_case: `return exact schema for Composio tool slug ${toolName}`,
            },
          ],
          session: { generate_id: true },
          model: "gpt-5.2",
        },
      },
    },
    sessionId,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${toolName}: Composio MCP request failed ${response.status}`,
    );
  }

  for (const message of parseSseJson(text)) {
    const content = message?.result?.content ?? [];
    for (const item of content) {
      if (item?.type !== "text") continue;
      const payload = JSON.parse(item.text);
      const schema = payload?.data?.tool_schemas?.[toolName];
      if (!schema) continue;
      return {
        description:
          typeof schema.description === "string"
            ? schema.description.replace(/\s+/gu, " ").trim()
            : undefined,
        inputSchema:
          schema.input_schema &&
          typeof schema.input_schema === "object" &&
          !Array.isArray(schema.input_schema)
            ? schema.input_schema
            : undefined,
      };
    }
  }
  return null;
};

const fillToolSchemas = async (provider) => {
  const missingTools = provider.tools.filter((tool) => !tool.inputSchema);
  const tools =
    Number.isFinite(schemaLimit) && schemaLimit > 0
      ? missingTools.slice(0, schemaLimit)
      : missingTools;
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.max(
    1,
    Math.min(schemaConcurrency, tools.length || 1),
  );
  const runWorker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const tool = tools[index];
      if (!tool) return;
      try {
        const exact = await searchExactToolSchema(tool.name);
        if (exact?.description) tool.description = exact.description;
        if (exact?.inputSchema) tool.inputSchema = exact.inputSchema;
      } catch (error) {
        console.warn(
          `${provider.id}: schema lookup failed for ${tool.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        completed += 1;
        if (completed % 25 === 0 || completed === tools.length) {
          console.error(
            `${provider.id}: schema lookups ${completed}/${tools.length}`,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
};

const { prefix, suffix, catalog } = await readCatalog();
const requested = new Set(providerArgs.map((id) => id.toLowerCase()));
if (summary) {
  const rows = catalog
    .filter((entry) => requested.size === 0 || requested.has(entry.id))
    .map((entry) => {
      const actionCount = entry.tools.length;
      const schemaCount = entry.tools.filter((tool) => tool.inputSchema).length;
      return {
        id: entry.id,
        actionCount,
        schemaCount,
        missingSchemaCount: actionCount - schemaCount,
      };
    });
  const totals = rows.reduce(
    (acc, row) => {
      acc.actionCount += row.actionCount;
      acc.schemaCount += row.schemaCount;
      acc.missingSchemaCount += row.missingSchemaCount;
      return acc;
    },
    { actionCount: 0, schemaCount: 0, missingSchemaCount: 0 },
  );
  console.log(
    JSON.stringify(
      {
        providers: rows.length,
        ...totals,
        rows: rows.filter((row) => row.missingSchemaCount > 0),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const candidates = catalog.filter((entry) => {
  if (excludedProviderIds.has(entry.id)) return false;
  return requested.size > 0
    ? requested.has(entry.id)
    : entry.catalogToolCount === 0 || entry.tools.length === 0;
});

if (candidates.length === 0) {
  console.log(
    JSON.stringify({ updated: [], message: "No providers to recover." }),
  );
  process.exit(0);
}

if (!apiKey) {
  usage();
  process.exit(2);
}

const updated = [];
for (const [providerIndex, provider] of candidates.entries()) {
  console.error(
    `${provider.id}: provider ${providerIndex + 1}/${candidates.length} (${provider.tools.length} existing tools)`,
  );
  if (!schemasOnly) {
    let tools;
    try {
      tools = await searchProvider(provider);
    } catch (error) {
      updated.push({
        id: provider.id,
        tools: provider.tools.length,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`${provider.id}: provider search failed`);
      continue;
    }
    if (tools.length === 0) {
      updated.push({ id: provider.id, tools: 0, changed: false });
      console.error(`${provider.id}: no tools returned`);
      continue;
    }
    const merged = new Map();
    for (const tool of provider.tools) merged.set(tool.name, tool);
    for (const tool of tools) merged.set(tool.name, tool);
    provider.tools = [...merged.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  if (fillMissingSchemas || schemasOnly) {
    await fillToolSchemas(provider);
  }
  provider.catalogToolCount = provider.tools.length;
  if (apply) {
    await writeFile(
      catalogPath,
      `${prefix}${JSON.stringify(catalog, null, 2)}${suffix}`,
      "utf8",
    );
  }
  updated.push({
    id: provider.id,
    tools: provider.tools.length,
    changed: true,
  });
  console.error(`${provider.id}: updated ${provider.tools.length} tools`);
}

if (apply) {
  await writeFile(
    catalogPath,
    `${prefix}${JSON.stringify(catalog, null, 2)}${suffix}`,
    "utf8",
  );
}

console.log(JSON.stringify({ apply, updated }, null, 2));
