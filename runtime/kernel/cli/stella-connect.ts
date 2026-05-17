#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import { callApiConnector } from "../connectors/api-client.js";
import {
  callConnectorBridgeTool,
  ConnectorAuthError,
  listConnectorBridgeTools,
} from "../connectors/connector-bridge.js";
import {
  listConfiguredApiConnectors,
  listConfiguredConnectorCommands,
  removeConfiguredConnector,
  saveConfiguredConnectorCommands,
} from "../connectors/state.js";
import type { ConnectorCommandConfig, ConnectorToolInfo } from "../connectors/types.js";
import { resolveStatePath } from "./shared.js";

const stateRoot = path.resolve(resolveStatePath());
const stellaRoot =
  path.basename(stateRoot) === "state" ? path.dirname(stateRoot) : path.dirname(stateRoot);

const printJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const parseJson = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    fail(`Invalid JSON: ${(error as Error).message}`);
  }
  return fallback;
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

const safeId = (value: string) => {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    fail(`Invalid connector id: ${value}`);
  }
  return id;
};

const findCommand = async (id: string) => {
  const commands = await listConfiguredConnectorCommands(stellaRoot);
  return commands.find((entry) => entry.id === id);
};

const findApi = async (id: string) => {
  const apis = await listConfiguredApiConnectors(stellaRoot);
  return apis.find((entry) => entry.id === id);
};

const writeGeneratedSkill = async (
  command: ConnectorCommandConfig,
  tools: ConnectorToolInfo[],
  { probeDeferred }: { probeDeferred: boolean } = { probeDeferred: false },
) => {
  const skillDir = path.join(stateRoot, "skills", command.id);
  await fs.mkdir(skillDir, { recursive: true });
  const toolLines = tools.length
    ? tools
        .map((tool) => {
          const description = tool.description ? ` - ${tool.description}` : "";
          return `- \`${tool.name}\`${description}`;
        })
        .join("\n")
    : probeDeferred
      ? `- _Actions list deferred until credentials are configured. Bind the token for \`${command.auth?.tokenKey ?? command.id}\`, then run \`stella-connect refresh-skill ${command.id}\`._`
      : "- Run `stella-connect tools <connector>` to inspect available actions.";
  const description = command.description ?? `Use the ${command.displayName} connector from Stella.`;
  const body = `---
name: ${command.id}
description: ${description.replace(/\n+/g, " ")}
---

# ${command.displayName}

Use this skill for work that needs ${command.displayName}.

Inspect available actions:

\`\`\`bash
stella-connect tools ${command.id}
\`\`\`

Call an action:

\`\`\`bash
stella-connect call ${command.id} <action-name> --json '{"key":"value"}'
\`\`\`

## Actions

${toolLines}
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf-8");
  return path.join(skillDir, "SKILL.md");
};

const importMcp = async (argv: string[]) => {
  const { options } = parseOptions(argv);
  const id = safeId(optionString(options, "id") ?? "");
  const displayName = optionString(options, "name") ?? id;
  const description = optionString(options, "description");
  const url = optionString(options, "url");
  const commandName = optionString(options, "command");
  const args = parseJson<string[]>(optionString(options, "args-json"), []);
  const env = parseJson<Record<string, string>>(optionString(options, "env-json"), {});
  const cwd = optionString(options, "cwd");
  const authType = optionString(options, "auth-type") as
    | "none"
    | "api_key"
    | "oauth"
    | undefined;
  const authTokenKey = optionString(options, "auth-token-key");
  const authHeaderName = optionString(options, "auth-header-name");
  const authScheme = optionString(options, "auth-scheme") as
    | "bearer"
    | "basic"
    | "raw"
    | undefined;
  const authEnvVar = optionString(options, "auth-env-var");

  if (!url && !commandName) {
    fail("Provide either --url or --command.");
  }
  if (url && commandName) {
    fail("Provide only one of --url or --command.");
  }

  const auth: ConnectorCommandConfig["auth"] = authType && authType !== "none"
    ? {
        type: authType,
        ...(authTokenKey ? { tokenKey: authTokenKey } : {}),
        ...(authHeaderName ? { headerName: authHeaderName } : {}),
        ...(authScheme ? { scheme: authScheme } : {}),
        ...(authEnvVar ? { envVar: authEnvVar } : {}),
      }
    : { type: "none" };

  const command: ConnectorCommandConfig = url
    ? {
        id,
        displayName,
        description,
        transport: "streamable_http",
        url,
        auth,
      }
    : {
        id,
        displayName,
        description,
        transport: "stdio",
        command: commandName,
        args,
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        auth,
      };

  // Probe first so we either capture the action list now or know we need
  // to defer until credentials are bound. Authenticated hosted MCPs can't
  // be probed at import time (no token has been saved for the new
  // tokenKey yet), so swallow `ConnectorAuthError` specifically and write
  // a stub skill. Real probe failures (network, malformed server,
  // unauthenticated 500s) still surface so the user doesn't silently
  // import a broken connector.
  let tools: ConnectorToolInfo[] = [];
  let probeDeferred = false;
  let probeDeferredReason: string | undefined;
  try {
    tools = await listConnectorBridgeTools(stellaRoot, command);
  } catch (error) {
    if (error instanceof ConnectorAuthError && auth.type !== "none") {
      probeDeferred = true;
      probeDeferredReason = error.message;
    } else {
      throw error;
    }
  }

  const existing = await listConfiguredConnectorCommands(stellaRoot);
  const next = new Map(existing.map((entry) => [entry.id, entry]));
  next.set(id, command);
  await saveConfiguredConnectorCommands(
    stellaRoot,
    [...next.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  );
  const skillPath = await writeGeneratedSkill(command, tools, {
    probeDeferred,
  });
  printJson({
    imported: command,
    tools,
    skillPath,
    ...(probeDeferred
      ? {
          probeDeferred: true,
          probeDeferredReason,
          hint: auth.tokenKey
            ? `Bind the credential under tokenKey "${auth.tokenKey}" (state/connectors/.credentials.json), then run \`stella-connect refresh-skill ${id}\` to populate the action list.`
            : `Configure auth, then run \`stella-connect refresh-skill ${id}\` to populate the action list.`,
        }
      : {}),
  });
};

const refreshSkill = async (id: string) => {
  const command = await findCommand(id);
  if (!command) fail(`Connector command is not installed: ${id}`);
  if (!command) return;
  const tools = await listConnectorBridgeTools(stellaRoot, command);
  const skillPath = await writeGeneratedSkill(command, tools, {
    probeDeferred: false,
  });
  printJson({ refreshed: command.id, tools, skillPath });
};

const HELP_TEXT = [
  "Usage: stella-connect <command>",
  "Commands:",
  "  installed                         List configured CLI/API connectors.",
  "  import-mcp --id <id> (--url <u> | --command <cmd> [--args-json '[]'])",
  "                                    Probe an MCP, persist it as a CLI connector, and",
  "                                    generate a matching skill under state/skills/<id>/.",
  "                                    For authenticated hosted MCPs, declare auth with",
  "                                    --auth-type/--auth-token-key/--auth-header-name/",
  "                                    --auth-scheme/--auth-env-var; the probe is deferred",
  "                                    until credentials land. Run `refresh-skill` after.",
  "  refresh-skill <id>                Re-probe a configured connector and rewrite its skill.",
  "  tools <id>                        List actions for a configured connector.",
  "  call <id> <action-or-path> [--json '{}'] [--method GET] [--query-json '{}']",
  "                                    Invoke a connector action or REST path.",
  "  remove <id>                       Remove a configured connector (state only).",
].join("\n");

const main = async () => {
  const [commandName, ...rest] = process.argv.slice(2);
  switch (commandName) {
    case "installed": {
      const [commands, apis] = await Promise.all([
        listConfiguredConnectorCommands(stellaRoot),
        listConfiguredApiConnectors(stellaRoot),
      ]);
      printJson({ commands, apis });
      return;
    }
    case "tools": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect tools <connector-id>");
      const command = await findCommand(id);
      if (!command) fail(`Connector command is not installed: ${id}`);
      if (!command) return;
      printJson(await listConnectorBridgeTools(stellaRoot, command));
      return;
    }
    case "call": {
      const { positionals, options } = parseOptions(rest);
      const id = positionals[0];
      const target = positionals[1];
      if (!id || !target) {
        fail("Usage: stella-connect call <connector-id> <tool-or-api-path> [--json '{}']");
      }
      const body = parseJson<Record<string, unknown>>(optionString(options, "json"), {});
      if (target.startsWith("/")) {
        const api = await findApi(id);
        if (!api) fail(`API connector is not installed: ${id}`);
        if (!api) return;
        printJson(
          await callApiConnector(stellaRoot, api, {
            method: optionString(options, "method"),
            path: target,
            query: parseJson<Record<string, string | number | boolean>>(
              optionString(options, "query-json"),
              {},
            ),
            body: Object.keys(body).length ? body : undefined,
          }),
        );
        return;
      }
      const command = await findCommand(id);
      if (!command) fail(`Connector command is not installed: ${id}`);
      if (!command) return;
      printJson(await callConnectorBridgeTool(stellaRoot, command, target, body));
      return;
    }
    case "import-mcp": {
      await importMcp(rest);
      return;
    }
    case "refresh-skill": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect refresh-skill <connector-id>");
      await refreshSkill(id);
      return;
    }
    case "remove": {
      const id = rest[0];
      if (!id) fail("Usage: stella-connect remove <connector-id>");
      printJson(await removeConfiguredConnector(stellaRoot, id));
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

main().catch((error) => {
  if (error instanceof ConnectorAuthError) {
    // Structured payload so callers (including the agent) can detect
    // auth failures without parsing the human-readable message. Exit 2
    // distinguishes auth failures from generic errors (exit 1).
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: "auth_required",
          status: error.status,
          tokenKey: error.tokenKey,
          displayName: error.serverDisplayName,
          message: error.message,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(2);
  }
  fail((error as Error).message);
});
