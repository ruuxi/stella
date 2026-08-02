#!/usr/bin/env node
import path from "node:path";

import {
  resolveNativeConnectorCatalog,
  type NativeCatalogSource,
} from "../connectors/catalog-cache.js";
import { getNativeConnectorReadiness } from "../connectors/connection-status.js";
import {
  requestBackendConnectorActionFromBridge,
  requestBackendConnectorActionsFromBridge,
  requestConnectorConnectionFromBridge,
  type BackendConnectorActionResult,
  type ConnectorConnectionResult,
} from "../connectors/cli-broker-client.js";
import {
  clearConnectorDecline,
  getConnectorDecline,
  recordConnectorDecline,
} from "../connectors/connect-preferences.js";
import { discoverConnectors } from "../connectors/discovery.js";
import {
  backendIntegrationRunToolName,
  disableNativeConnector,
  getNativeConnectorCatalogEntry,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
  type NativeConnectorCatalogOverride,
} from "../connectors/native-integrations.js";
import { resolveStatePath } from "./shared.js";

const stellaAppDir = path.resolve(resolveStatePath());

const printJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const exitStructured = (payload: Record<string, unknown>): never => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(2);
};

const parseJson = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    return fail(`Invalid JSON: ${(error as Error).message}`);
  }
};

const parseOptions = (argv: string[]) => {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      positionals.push(entry);
      continue;
    }
    const eqIndex = entry.indexOf("=");
    if (eqIndex > -1) {
      options[entry.slice(2, eqIndex)] = entry.slice(eqIndex + 1);
      continue;
    }
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
};

const optionString = (
  options: Record<string, string | boolean>,
  key: string,
): string | undefined => {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
};

const loadCatalog = async () =>
  resolveNativeConnectorCatalog({ stellaDataDir: stellaAppDir });

const findEntry = (
  id: string,
  catalog: NativeConnectorCatalogOverride,
): NativeConnectorCatalogEntry =>
  getNativeConnectorCatalogEntry(id, catalog) ??
  fail(
    `Unknown Store integration: ${id}. Refresh Stella's integration catalog and try again.`,
  );

const diagnostics = (
  entry: NativeConnectorCatalogEntry,
  source: NativeCatalogSource,
) => ({
  catalogSource: source,
  provider: entry.provider,
  toolCount: getNativeConnectorTools(entry).length,
  actionCount: entry.catalogToolCount,
});

const callBackendIntegration = async (
  connectorId: string,
  action: string,
  input: Record<string, unknown>,
) => {
  const socketPath =
    process.env.STELLA_CLI_BRIDGE_SOCK?.trim() ||
    fail(
      process.platform === "win32"
        ? "Secure connector action brokering is unavailable on Windows."
        : "The Stella connector action broker is unavailable.",
    );
  const result: BackendConnectorActionResult =
    await requestBackendConnectorActionFromBridge({
      socketPath,
      connectorId,
      action,
      input,
    }).catch(() => ({
      ok: false as const,
      reason: "bridge_unavailable",
      message: "The Stella connector broker is unavailable.",
    }));
  if (result.ok) return result.result;
  const suffix = result.status
    ? ` (status ${result.status}${result.requestId ? `, request ${result.requestId}` : ""})`
    : "";
  fail(
    `${
      result.message ??
      (result.reason === "not_signed_in"
        ? "Sign in to Stella before using this integration."
        : result.reason === "auth_expired"
          ? "Stella sign-in expired. Sign in again before using this integration."
          : "The Stella connector broker could not run this action.")
    }${suffix}`,
  );
};

const ensureEnabled = async (
  entry: NativeConnectorCatalogEntry,
): Promise<void> => {
  if (await isNativeConnectorEnabled(stellaAppDir, entry.id)) return;
  fail(
    `${entry.name} is not connected. Connect it from the inline chat card or Store before calling it.`,
  );
};

const listBackendActions = async (
  entry: NativeConnectorCatalogEntry,
  args: string[],
) => {
  const socketPath =
    process.env.STELLA_CLI_BRIDGE_SOCK?.trim() ||
    fail("The Stella connector action broker is unavailable.");
  const { positionals, options } = parseOptions(args);
  const query = positionals.join(" ").trim() || undefined;
  const cursor = optionString(options, "cursor");
  const rawLimit = optionString(options, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    fail("--limit must be an integer from 1 to 25.");
  }
  const result = await requestBackendConnectorActionsFromBridge({
    socketPath,
    connectorId: entry.id,
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  }).catch(() => ({
    ok: false as const,
    reason: "bridge_unavailable",
    message: "The Stella connector action broker is unavailable.",
  }));
  if (result.ok) return result;
  fail(
    result.message ??
      (result.reason === "not_signed_in"
        ? "Sign in to Stella before inspecting integration actions."
        : "Could not load integration actions."),
  );
};

const HELP_TEXT = [
  "Usage: stella-connect <command>",
  "Commands:",
  "  installed                         List locally enabled Store integrations.",
  "  apps                              List the cached Store integration catalog.",
  "  discover <keywords>               Search the Store integration catalog and report",
  "                                    enabled/connected/declined state.",
  '  request-connection <id> [--reason "..."] [--requested-by-user]',
  "                                    Offer the integration through an inline chat card;",
  "                                    blocks until OAuth completes or the user declines.",
  "  disable-native <id>               Disable it and remove its generated skill.",
  "  tools <id> [keywords] [--cursor x] List canonical actions and schemas on demand.",
  "  tools-diagnostics <id>            Include catalog/readiness diagnostics.",
  "  catalog-actions <id> [keywords]    Alias for tools.",
  "  call <id> <action> [--json '{}']  Run an action through Stella's backend connector.",
].join("\n");

const main = async () => {
  const [commandName, ...rest] = process.argv.slice(2);
  const catalog = await loadCatalog();

  switch (commandName) {
    case "installed": {
      const entries = await listNativeConnectors(stellaAppDir, catalog.entries);
      printJson({
        native: await Promise.all(
          entries
            .filter((entry) => entry.enabled)
            .map(async (entry) => {
              const readiness = await getNativeConnectorReadiness(
                stellaAppDir,
                entry,
              );
              return {
                ...entry,
                providerStatus: readiness.authStatus,
                accountVerified: readiness.accountVerified,
                executable: readiness.executable,
                ...diagnostics(
                  entry,
                  catalog.sources[entry.id] ?? catalog.source,
                ),
              };
            }),
        ),
      });
      return;
    }
    case "apps": {
      const entries = await listNativeConnectors(stellaAppDir, catalog.entries);
      printJson(
        await Promise.all(
          entries.map(async (entry) => {
            const readiness = await getNativeConnectorReadiness(
              stellaAppDir,
              entry,
            );
            return {
              ...entry,
              providerStatus: readiness.authStatus,
              accountVerified: readiness.accountVerified,
              executable: readiness.executable,
              ...diagnostics(
                entry,
                catalog.sources[entry.id] ?? catalog.source,
              ),
            };
          }),
        ),
      );
      return;
    }
    case "discover": {
      const { positionals } = parseOptions(rest);
      const query = positionals.join(" ").trim();
      if (!query) fail("Usage: stella-connect discover <keywords>");
      const entries = await listNativeConnectors(stellaAppDir, catalog.entries);
      const enabledIds = new Set(
        entries.filter((entry) => entry.enabled).map((entry) => entry.id),
      );
      const matches = await discoverConnectors(stellaAppDir, query, {
        catalogOverride: catalog.entries,
        enabledNativeIds: enabledIds,
      });
      printJson({
        query,
        matches: await Promise.all(
          matches.map(async (match) => {
            const entry = findEntry(match.id, catalog.entries);
            const readiness = await getNativeConnectorReadiness(
              stellaAppDir,
              entry,
            );
            return {
              ...match,
              connected: readiness.connected,
              providerStatus: readiness.authStatus,
              accountVerified: readiness.accountVerified,
              executable: readiness.executable,
              ...diagnostics(
                entry,
                catalog.sources[entry.id] ?? catalog.source,
              ),
              next: readiness.connected
                ? `Ready. Inspect actions: stella-connect catalog-actions ${entry.id}`
                : match.declined
                  ? "The user previously declined connecting this integration. Do not offer it again unless they explicitly ask to connect it now."
                  : "Not connected. The orchestrator can show the inline connect card; otherwise the user can connect it from the Store.",
            };
          }),
        ),
      });
      return;
    }
    case "request-connection": {
      const { positionals, options } = parseOptions(rest);
      const id = positionals[0];
      if (!id) {
        fail(
          'Usage: stella-connect request-connection <integration-id> [--reason "..."] [--requested-by-user]',
        );
      }
      const entry = findEntry(id, catalog.entries);
      const priorDecline = await getConnectorDecline(stellaAppDir, entry.id);
      if (priorDecline && options["requested-by-user"] !== true) {
        exitStructured({
          ok: false,
          error: "previously_declined",
          id: entry.id,
          declinedAt: priorDecline.declinedAt,
          message: `The user previously declined connecting ${entry.name}.`,
        });
      }
      const socketPath =
        process.env.STELLA_CLI_BRIDGE_SOCK ??
        exitStructured({
          ok: false,
          error: "bridge_unavailable",
          id: entry.id,
          message: "The desktop bridge cannot show the inline connect card.",
        });
      const result: ConnectorConnectionResult =
        await requestConnectorConnectionFromBridge({
          socketPath,
          id: entry.id,
          name: entry.name,
          description: entry.description,
          iconUrl: entry.iconUrl,
          category: entry.category,
          reason: optionString(options, "reason"),
        }).catch((error): never =>
          exitStructured({
            ok: false,
            error: "bridge_unavailable",
            id: entry.id,
            message: (error as Error).message,
          }),
        );
      if (result.ok) {
        await clearConnectorDecline(stellaAppDir, entry.id).catch(
          () => undefined,
        );
        printJson({
          ok: true,
          status: result.status,
          id: entry.id,
          skillPath: `~/.stella/skills/${entry.id}/SKILL.md`,
          hint: `Continue the original task with stella-connect call ${entry.id} <action> --json '{}'.`,
        });
        return;
      }
      if (result.reason === "declined") {
        await recordConnectorDecline(stellaAppDir, entry.id).catch(
          () => undefined,
        );
      }
      exitStructured({
        ok: false,
        error: result.reason,
        id: entry.id,
        message: `Could not connect ${entry.name}: ${result.reason}.`,
      });
    }
    case "disable-native": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect disable-native <integration-id>");
      printJson(
        await disableNativeConnector(stellaAppDir, id, catalog.entries),
      );
      return;
    }
    case "tools": {
      const [id, ...actionArgs] = rest;
      if (!id) fail("Usage: stella-connect tools <integration-id>");
      const entry = findEntry(id, catalog.entries);
      await ensureEnabled(entry);
      printJson(await listBackendActions(entry, actionArgs));
      return;
    }
    case "tools-diagnostics": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect tools-diagnostics <integration-id>");
      const entry = findEntry(id, catalog.entries);
      await ensureEnabled(entry);
      const readiness = await getNativeConnectorReadiness(stellaAppDir, entry);
      const actionPage = await listBackendActions(entry, rest.slice(1));
      printJson({
        ...diagnostics(entry, catalog.sources[entry.id] ?? catalog.source),
        providerStatus: readiness.authStatus,
        accountVerified: readiness.accountVerified,
        enabled: readiness.enabled,
        executable: readiness.executable,
        runnerTools: getNativeConnectorTools(entry),
        actionPage,
      });
      return;
    }
    case "catalog-actions": {
      const [id, ...actionArgs] = rest;
      if (!id) fail("Usage: stella-connect catalog-actions <integration-id>");
      const entry = findEntry(id, catalog.entries);
      await ensureEnabled(entry);
      printJson(await listBackendActions(entry, actionArgs));
      return;
    }
    case "call": {
      const { positionals, options } = parseOptions(rest);
      const id = positionals[0];
      const requestedAction = positionals[1];
      if (!id || !requestedAction) {
        fail(
          "Usage: stella-connect call <integration-id> <action> [--json '{}']",
        );
      }
      const entry = findEntry(id, catalog.entries);
      await ensureEnabled(entry);
      const input = parseJson<Record<string, unknown>>(
        optionString(options, "json"),
        {},
      );
      const runnerAction = backendIntegrationRunToolName(id);
      const action =
        requestedAction === runnerAction
          ? typeof input.action === "string" && input.action.trim()
            ? input.action.trim()
            : fail(`${runnerAction} requires an action string.`)
          : requestedAction;
      const actionInput =
        requestedAction === runnerAction &&
        input.arguments &&
        typeof input.arguments === "object" &&
        !Array.isArray(input.arguments)
          ? (input.arguments as Record<string, unknown>)
          : requestedAction === runnerAction
            ? {}
            : input;
      printJson(await callBackendIntegration(id, action, actionInput));
      return;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP_TEXT}\n`);
      return;
    default:
      fail(HELP_TEXT);
  }
};

main().catch((error) => fail((error as Error).message));
