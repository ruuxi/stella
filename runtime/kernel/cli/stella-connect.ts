#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import { callApiConnector } from "../connectors/api-client.js";
import {
  callConnectorBridgeTool,
  listConnectorBridgeTools,
} from "../connectors/connector-bridge.js";
import {
  installOfficialConnector,
  listConfiguredApiConnectors,
  listConfiguredConnectorCommands,
  listOfficialConnectorDefinitions,
  listStellaConnectors,
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

  if (!url && !commandName) {
    fail("Provide either --url or --command.");
  }
  if (url && commandName) {
    fail("Provide only one of --url or --command.");
  }

  const command: ConnectorCommandConfig = url
    ? {
        id,
        displayName,
        description,
        transport: "streamable_http",
        url,
        auth: { type: "none" },
        source: { marketplaceKey: id },
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
        auth: { type: "none" },
        source: { marketplaceKey: id },
      };

  const tools = await listConnectorBridgeTools(stellaRoot, command);
  const existing = await listConfiguredConnectorCommands(stellaRoot);
  const next = new Map(existing.map((entry) => [entry.id, entry]));
  next.set(id, command);
  await saveConfiguredConnectorCommands(
    stellaRoot,
    [...next.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  );
  const skillPath = await writeGeneratedSkill(command, tools);
  printJson({ imported: command, tools, skillPath });
};

const main = async () => {
  const [commandName, ...rest] = process.argv.slice(2);
  switch (commandName) {
    case "catalog": {
      printJson(await listStellaConnectors(stellaRoot));
      return;
    }
    case "official": {
      printJson(listOfficialConnectorDefinitions());
      return;
    }
    case "installed": {
      const [commands, apis] = await Promise.all([
        listConfiguredConnectorCommands(stellaRoot),
        listConfiguredApiConnectors(stellaRoot),
      ]);
      printJson({ commands, apis });
      return;
    }
    case "install": {
      const { positionals, options } = parseOptions(rest);
      const marketplaceKey = positionals[0];
      if (!marketplaceKey) fail("Usage: stella-connect install <marketplace-key> [--config-json '{}']");
      const config = parseJson<Record<string, string>>(optionString(options, "config-json"), {});
      printJson(await installOfficialConnector(stellaRoot, marketplaceKey, config));
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
    default:
      fail(
        [
          "Usage: stella-connect <command>",
          "Commands: catalog, official, installed, install, tools, call, import-mcp",
        ].join("\n"),
      );
  }
};

main().catch((error) => fail((error as Error).message));
