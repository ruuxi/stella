import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { LocalSchedulerService } from "../local-scheduler-service.js";
import { getPersonalityFilePath } from "../personality/personality.js";
import {
  loadLocalPreferences,
  saveLocalPreferences,
} from "../preferences/local-preferences.js";
import type { StellaHostRunnerTarget } from "../lifecycle-targets.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import type {
  LocalCronJobCreateInput,
  LocalCronSchedule,
} from "../shared/scheduling.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../storage/database-init.js";
import type { SqliteDatabase } from "../storage/shared.js";
import { generateLocalId } from "../storage/shared.js";
import { SessionStore } from "../storage/session-store.js";

export type ThirdPartyMigrationSource = "hermes" | "openclaw";

export type ThirdPartyMigrationOption =
  | "memory"
  | "user"
  | "sessionHistory"
  | "skills"
  | "personality"
  | "modelConfig"
  | "schedules";

export type ThirdPartyMigrationSelection = Partial<
  Record<ThirdPartyMigrationOption, boolean>
>;

export type ThirdPartyMigrationFinding = {
  option: ThirdPartyMigrationOption;
  label: string;
  found: boolean;
  count: number;
  paths: string[];
  note?: string;
};

export type ThirdPartyMigrationPreview = {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  displayName: string;
  found: boolean;
  findings: ThirdPartyMigrationFinding[];
};

export type ThirdPartyMigrationReportItem = {
  kind: ThirdPartyMigrationOption | "channels" | "source" | "report";
  status: "imported" | "skipped" | "manual" | "error";
  source?: string;
  target?: string;
  message: string;
  count?: number;
};

export type ThirdPartyMigrationReport = {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  stellaHome: string;
  startedAt: string;
  completedAt: string;
  markdownPath: string;
  items: ThirdPartyMigrationReportItem[];
};

type ImportedState = {
  version: 1;
  sources: Record<string, Record<string, string>>;
};

type SourcePaths = {
  memoryFiles: string[];
  userFiles: string[];
  personalityFiles: string[];
  skillDirs: string[];
  modelConfigFiles: string[];
  hermesStateDb?: string;
  openClawSessionFiles: string[];
  scheduleFiles: string[];
};

type SourceSessionMessage = {
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
};

type SourceSession = {
  id: string;
  timestamp: number;
  messages: SourceSessionMessage[];
};

type SqliteDatabaseCtor = new (
  filename: string,
  options?: Record<string, unknown>,
) => SqliteDatabase;

const PRODUCT_LABELS: Record<ThirdPartyMigrationSource, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const PRODUCT_REPOS: Record<ThirdPartyMigrationSource, string> = {
  hermes: "https://github.com/NousResearch/hermes-agent",
  openclaw: "https://github.com/openclaw/openclaw",
};

const DEFAULT_OPTIONS: Record<ThirdPartyMigrationOption, boolean> = {
  memory: true,
  user: true,
  sessionHistory: true,
  skills: true,
  personality: true,
  modelConfig: true,
  schedules: true,
};

const ENTRY_DELIMITER = "\n§\n";
const IMPORT_STATE_FILE = path.join("migrations", "third-party-imports.json");
const REPORTS_DIR = path.join("migrations", "reports");
const MAX_IMPORTED_SESSIONS = 100;
const MAX_IMPORTED_SESSION_MESSAGES = 200;

const normalizeText = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const expandHome = (value: string, homeDir = os.homedir()): string => {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readTextIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const readJsonIfExists = async (filePath: string): Promise<unknown> => {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readJsonLikeIfExists = async (filePath: string): Promise<unknown> => {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  return parseJsonLikeText(text);
};

const parseJsonLikeText = async (text: string): Promise<unknown> => {
  try {
    return JSON.parse(text);
  } catch {}
  try {
    const json5 = await dynamicImport("json5");
    const parser = isRecord(json5.default) ? json5.default : json5;
    if (typeof parser.parse === "function") {
      return parser.parse(text) as unknown;
    }
  } catch {}
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values.map((value) => path.resolve(value)))].sort((a, b) =>
    a.localeCompare(b),
  );

const hashText = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const hashPath = async (filePath: string): Promise<string> => {
  const stat = await fsp.lstat(filePath);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(filePath, { withFileTypes: true });
    const chunks: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(filePath, entry.name);
      chunks.push(`${entry.name}:${await hashPath(child)}`);
    }
    return hashText(chunks.join("\n"));
  }
  if (!stat.isFile()) {
    return hashText(`${filePath}:${stat.mtimeMs}`);
  }
  return hashText(await fsp.readFile(filePath, "utf-8").catch(() => ""));
};

const dynamicImport = (specifier: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;

const loadSqliteDatabaseCtor = async (): Promise<SqliteDatabaseCtor> => {
  try {
    const nodeSqlite = await dynamicImport("node:sqlite");
    if (typeof nodeSqlite.DatabaseSync === "function") {
      return nodeSqlite.DatabaseSync as SqliteDatabaseCtor;
    }
  } catch {}
  const bunSqlite = await dynamicImport("bun:sqlite");
  if (typeof bunSqlite.Database === "function") {
    return bunSqlite.Database as SqliteDatabaseCtor;
  }
  throw new Error("No compatible SQLite runtime is available.");
};

const importStatePath = (stellaHome: string): string =>
  path.join(stellaHome, IMPORT_STATE_FILE);

const readImportState = async (stellaHome: string): Promise<ImportedState> => {
  const parsed = await readJsonIfExists(importStatePath(stellaHome));
  if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sources)) {
    return parsed as ImportedState;
  }
  return { version: 1, sources: {} };
};

const writeImportState = async (
  stellaHome: string,
  state: ImportedState,
): Promise<void> => {
  const filePath = importStatePath(stellaHome);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
};

const sourceKey = (
  source: ThirdPartyMigrationSource,
  sourceRoot: string,
): string => `${source}:${path.resolve(sourceRoot)}`;

const alreadyImported = (
  state: ImportedState,
  key: string,
  itemId: string,
  fingerprint: string,
): boolean => state.sources[key]?.[itemId] === fingerprint;

const markImported = (
  state: ImportedState,
  key: string,
  itemId: string,
  fingerprint: string,
): void => {
  state.sources[key] ??= {};
  state.sources[key][itemId] = fingerprint;
};

const resolveSourceConfiguredPath = (
  sourceRoot: string,
  value: string,
): string => {
  if (value === "~" || value.startsWith("~/")) {
    return path.resolve(expandHome(value));
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(sourceRoot, value);
};

const resolveSourceConfiguredPathCandidates = (
  sourceRoot: string,
  configRoot: string,
  value: string,
): string[] => {
  const primary = resolveSourceConfiguredPath(sourceRoot, value);
  if (value === "~" || value.startsWith("~/") || path.isAbsolute(value)) {
    return [primary];
  }
  return uniqueSorted([primary, path.resolve(configRoot, value)]);
};

export const resolveDefaultMigrationSourceRoot = (
  source: ThirdPartyMigrationSource,
  opts?: { homeDir?: string; env?: NodeJS.ProcessEnv },
): string => {
  const homeDir = opts?.homeDir ?? os.homedir();
  const env = opts?.env ?? process.env;
  if (source === "hermes") {
    return path.resolve(expandHome(env.HERMES_HOME?.trim() || "~/.hermes", homeDir));
  }
  return path.resolve(
    expandHome(env.OPENCLAW_STATE_DIR?.trim() || "~/.openclaw", homeDir),
  );
};

export const detectThirdPartyMigrationSources = async (opts?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ThirdPartyMigrationPreview[]> => {
  const homeDir = opts?.homeDir ?? os.homedir();
  const candidates: Array<[ThirdPartyMigrationSource, string]> = [
    ["hermes", resolveDefaultMigrationSourceRoot("hermes", opts)],
    ["openclaw", resolveDefaultMigrationSourceRoot("openclaw", opts)],
    ["openclaw", path.join(homeDir, ".clawdbot")],
  ];

  const previews: ThirdPartyMigrationPreview[] = [];
  const seen = new Set<string>();
  for (const [source, root] of candidates) {
    const resolved = path.resolve(root);
    const key = `${source}:${resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await pathExists(resolved))) continue;
    const preview = await previewThirdPartyMigration({ source, sourceRoot: resolved });
    if (preview.found) {
      previews.push(preview);
    }
  }
  return previews;
};

export const previewThirdPartyMigration = async (opts: {
  source: ThirdPartyMigrationSource;
  sourceRoot?: string;
}): Promise<ThirdPartyMigrationPreview> => {
  const sourceRoot =
    opts.sourceRoot ?? resolveDefaultMigrationSourceRoot(opts.source);
  const paths = await collectSourcePaths(opts.source, sourceRoot);
  const findings: ThirdPartyMigrationFinding[] = [
    {
      option: "memory",
      label: "Memory",
      found: paths.memoryFiles.length > 0,
      count: paths.memoryFiles.length,
      paths: paths.memoryFiles,
    },
    {
      option: "user",
      label: "User profile",
      found: paths.userFiles.length > 0,
      count: paths.userFiles.length,
      paths: paths.userFiles,
    },
    {
      option: "sessionHistory",
      label: "Session history",
      found: Boolean(paths.hermesStateDb) || paths.openClawSessionFiles.length > 0,
      count: (paths.hermesStateDb ? 1 : 0) + paths.openClawSessionFiles.length,
      paths: [
        ...(paths.hermesStateDb ? [paths.hermesStateDb] : []),
        ...paths.openClawSessionFiles,
      ],
      note: "Best effort import; Stella can rebuild search indexes after import.",
    },
    {
      option: "skills",
      label: "Skills",
      found: paths.skillDirs.length > 0,
      count: paths.skillDirs.length,
      paths: paths.skillDirs,
      note: "Imported skills can be reviewed and published from Store later.",
    },
    {
      option: "personality",
      label: "Personality",
      found: paths.personalityFiles.length > 0,
      count: paths.personalityFiles.length,
      paths: paths.personalityFiles,
    },
    {
      option: "modelConfig",
      label: "Model settings",
      found: paths.modelConfigFiles.length > 0,
      count: paths.modelConfigFiles.length,
      paths: paths.modelConfigFiles,
      note: "Provider/model names are preserved when Stella can identify them.",
    },
    {
      option: "schedules",
      label: "Schedules",
      found: paths.scheduleFiles.length > 0,
      count: paths.scheduleFiles.length,
      paths: paths.scheduleFiles,
      note: "Imported as Stella scheduler jobs where the schedule shape is compatible.",
    },
  ];

  return {
    source: opts.source,
    sourceRoot: path.resolve(sourceRoot),
    displayName: PRODUCT_LABELS[opts.source],
    found: findings.some((finding) => finding.found),
    findings,
  };
};

const collectSourcePaths = async (
  source: ThirdPartyMigrationSource,
  sourceRoot: string,
): Promise<SourcePaths> => {
  if (source === "hermes") {
    return collectHermesPaths(sourceRoot);
  }
  return collectOpenClawPaths(sourceRoot);
};

const collectHermesPaths = async (sourceRoot: string): Promise<SourcePaths> => {
  const root = path.resolve(sourceRoot);
  const skillRoot = path.join(root, "skills");
  const schedulePath = path.join(root, "cron", "jobs.json");
  const stateDb = path.join(root, "state.db");
  return {
    memoryFiles: await existingFiles([
      path.join(root, "memories", "MEMORY.md"),
      path.join(root, "MEMORY.md"),
    ]),
    userFiles: await existingFiles([
      path.join(root, "memories", "USER.md"),
      path.join(root, "USER.md"),
    ]),
    personalityFiles: await existingFiles([
      path.join(root, "memories", "SOUL.md"),
      path.join(root, "SOUL.md"),
    ]),
    skillDirs: await listSkillDirs([skillRoot]),
    modelConfigFiles: await existingFiles([path.join(root, "config.yaml")]),
    hermesStateDb: (await pathExists(stateDb)) ? stateDb : undefined,
    openClawSessionFiles: [],
    scheduleFiles: await existingFiles([schedulePath]),
  };
};

const collectOpenClawPaths = async (sourceRoot: string): Promise<SourcePaths> => {
  const root = path.resolve(sourceRoot);
  const configPath = await resolveOpenClawConfigPath(root);
  const config = configPath ? await readJsonLikeIfExists(configPath) : null;
  const configRoot = configPath ? path.dirname(configPath) : root;
  const workspaces = await resolveOpenClawWorkspaceCandidates(
    root,
    config,
    configRoot,
  );
  return {
    memoryFiles: await collectOpenClawMemoryFiles(workspaces),
    userFiles: await existingFiles(workspaces.map((workspace) => path.join(workspace, "USER.md"))),
    personalityFiles: await existingFiles(
      workspaces.flatMap((workspace) => [
        path.join(workspace, "SOUL.md"),
        path.join(workspace, "IDENTITY.md"),
      ]),
    ),
    skillDirs: await listSkillDirs([
      ...workspaces.map((workspace) => path.join(workspace, "skills")),
      ...workspaces.map((workspace) => path.join(workspace, ".agents", "skills")),
      path.join(root, "skills"),
    ]),
    modelConfigFiles: configPath ? [configPath] : [],
    openClawSessionFiles: await listOpenClawSessionFiles(
      root,
      config,
      configRoot,
    ),
    scheduleFiles: [],
  };
};

const resolveOpenClawConfigPath = async (
  sourceRoot: string,
): Promise<string | null> => {
  const envPath = asString(process.env.OPENCLAW_CONFIG_PATH);
  if (envPath) {
    const resolved = resolveSourceConfiguredPath(sourceRoot, envPath);
    return (await pathExists(resolved)) ? resolved : null;
  }
  return firstExistingFile([
    path.join(sourceRoot, "openclaw.json"),
    path.join(sourceRoot, "openclaw.json5"),
    path.join(sourceRoot, "clawdbot.json"),
    path.join(sourceRoot, "moltbot.json"),
  ]);
};

const existingFiles = async (files: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const file of uniqueSorted(files)) {
    try {
      const stat = await fsp.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) out.push(file);
    } catch {}
  }
  return out;
};

const firstExistingFile = async (files: string[]): Promise<string | null> => {
  const matches = await existingFiles(files);
  return matches[0] ?? null;
};

const collectOpenClawMemoryFiles = async (
  workspaces: string[],
): Promise<string[]> => {
  const rootMemoryFiles = await existingFiles(
    workspaces.flatMap((workspace) => [
      path.join(workspace, "MEMORY.md"),
      path.join(workspace, "memory.md"),
    ]),
  );
  const memoryTreeFiles = (
    await Promise.all(
      workspaces.map((workspace) =>
        listMarkdownFiles(path.join(workspace, "memory")),
      ),
    )
  ).flat();
  return uniqueSorted([...rootMemoryFiles, ...memoryTreeFiles]);
};

const listMarkdownFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(nextPath);
      } else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
        out.push(nextPath);
      }
    }
  };
  try {
    await visit(root);
  } catch {}
  return uniqueSorted(out);
};

const listSkillDirs = async (roots: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const root of uniqueSorted(roots)) {
    try {
      const visit = async (dir: string): Promise<void> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        if (await pathExists(path.join(dir, "SKILL.md"))) {
          out.push(dir);
          return;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          if ([".git", "node_modules", "__pycache__"].includes(entry.name)) {
            continue;
          }
          await visit(path.join(dir, entry.name));
        }
      };
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if ([".git", "node_modules", "__pycache__"].includes(entry.name)) {
          continue;
        }
        await visit(path.join(root, entry.name));
      }
    } catch {}
  }
  return uniqueSorted(out);
};

const resolveOpenClawWorkspaceCandidates = async (
  sourceRoot: string,
  config: unknown,
  configRoot: string,
): Promise<string[]> => {
  const candidates = [
    ...openClawEnvWorkspaceCandidates(sourceRoot),
    path.join(sourceRoot, "workspace"),
    path.join(sourceRoot, "workspace-main"),
    path.join(sourceRoot, "workspace-assistant"),
    path.join(sourceRoot, "workspace.default"),
    ...(await openClawProfileWorkspaceCandidates(sourceRoot)),
  ];
  if (isRecord(config)) {
    const agents = config.agents;
    if (isRecord(agents)) {
      const defaults = agents.defaults;
      if (isRecord(defaults)) {
        const workspace = asString(defaults.workspace);
        if (workspace) {
          candidates.unshift(
            ...resolveSourceConfiguredPathCandidates(
              sourceRoot,
              configRoot,
              workspace,
            ),
          );
        }
      }
      const list = agents.list;
      if (Array.isArray(list)) {
        for (const agent of list) {
          if (!isRecord(agent)) continue;
          const workspace = asString(agent.workspace);
          if (workspace) {
            candidates.push(
              ...resolveSourceConfiguredPathCandidates(
                sourceRoot,
                configRoot,
                workspace,
              ),
            );
          }
        }
      }
    }
  }
  const existing: string[] = [];
  for (const candidate of uniqueSorted(candidates)) {
    try {
      const stat = await fsp.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) existing.push(candidate);
    } catch {}
  }
  return existing;
};

const openClawEnvWorkspaceCandidates = (sourceRoot: string): string[] => {
  const workspace = asString(process.env.OPENCLAW_WORKSPACE_DIR);
  return workspace ? [resolveSourceConfiguredPath(sourceRoot, workspace)] : [];
};

const openClawProfileWorkspaceCandidates = async (
  sourceRoot: string,
): Promise<string[]> => {
  try {
    const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^workspace-[^/\\]+$/u.test(entry.name),
      )
      .map((entry) => path.join(sourceRoot, entry.name));
  } catch {
    return [];
  }
};

const listOpenClawSessionFiles = async (
  sourceRoot: string,
  config: unknown,
  configRoot: string,
): Promise<string[]> => {
  const agentsRoot = path.join(sourceRoot, "agents");
  const out: string[] = [];
  try {
    const agents = await fsp.readdir(agentsRoot, { withFileTypes: true });
    for (const agent of agents) {
      if (!agent.isDirectory() || agent.isSymbolicLink()) continue;
      const sessionsRoot = path.join(agentsRoot, agent.name, "sessions");
      try {
        const files = await fsp.readdir(sessionsRoot, { withFileTypes: true });
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(".jsonl")) {
            out.push(path.join(sessionsRoot, file.name));
          }
        }
      } catch {}
    }
  } catch {}
  out.push(
    ...(await listOpenClawSessionStoreFiles(sourceRoot, config, configRoot)),
  );
  const configuredSessionFiles = collectOpenClawSessionFileRefs(config).flatMap(
    (file) =>
      resolveSourceConfiguredPathCandidates(sourceRoot, configRoot, file),
  );
  out.push(...(await existingFiles(configuredSessionFiles)));
  return uniqueSorted(out.filter((file) => file.endsWith(".jsonl")));
};

const listOpenClawSessionStoreFiles = async (
  sourceRoot: string,
  config: unknown,
  configRoot: string,
): Promise<string[]> => {
  const out: string[] = [];
  const storePaths = await listOpenClawSessionStorePaths(
    sourceRoot,
    config,
    configRoot,
  );
  for (const storePath of storePaths) {
    const store = await readJsonLikeIfExists(storePath);
    if (!isRecord(store)) continue;
    const sessionsDir = path.dirname(storePath);
    const candidates = Object.values(store).flatMap((entry) =>
      resolveOpenClawSessionStoreEntryFiles(sessionsDir, entry),
    );
    out.push(...await existingFiles(candidates));
  }
  return uniqueSorted(out);
};

const listOpenClawSessionStorePaths = async (
  sourceRoot: string,
  config: unknown,
  configRoot: string,
): Promise<string[]> => {
  const agentIds = await listOpenClawAgentIds(sourceRoot, config);
  const configuredStore = isRecord(config) && isRecord(config.session)
    ? asString(config.session.store)
    : null;
  const candidates = new Set<string>();
  for (const agentId of agentIds) {
    for (const candidate of resolveOpenClawSessionStorePaths(
      sourceRoot,
      configRoot,
      configuredStore,
      agentId,
    )) {
      candidates.add(candidate);
    }
    candidates.add(
      path.join(sourceRoot, "agents", agentId, "sessions", "sessions.json"),
    );
  }
  candidates.add(path.join(sourceRoot, "sessions.json"));
  return existingFiles([...candidates]);
};

const listOpenClawAgentIds = async (
  sourceRoot: string,
  config: unknown,
): Promise<string[]> => {
  const ids = new Set<string>(["main"]);
  if (isRecord(config) && isRecord(config.agents)) {
    const list = config.agents.list;
    if (Array.isArray(list)) {
      for (const agent of list) {
        if (!isRecord(agent)) continue;
        const id = asString(agent.id);
        if (id) ids.add(sanitizeOpenClawAgentId(id));
      }
    }
  }
  try {
    const entries = await fsp.readdir(path.join(sourceRoot, "agents"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        ids.add(sanitizeOpenClawAgentId(entry.name));
      }
    }
  } catch {}
  return [...ids].sort((a, b) => a.localeCompare(b));
};

const sanitizeOpenClawAgentId = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "main";

const resolveOpenClawSessionStorePaths = (
  sourceRoot: string,
  configRoot: string,
  configuredStore: string | null,
  agentId: string,
): string[] => {
  if (!configuredStore) {
    return [
      path.join(sourceRoot, "agents", agentId, "sessions", "sessions.json"),
    ];
  }
  const expanded = configuredStore.replaceAll("{agentId}", agentId);
  return resolveSourceConfiguredPathCandidates(sourceRoot, configRoot, expanded);
};

const resolveOpenClawSessionStoreEntryFiles = (
  sessionsDir: string,
  entry: unknown,
): string[] => {
  if (!isRecord(entry)) return [];
  const sessionFile = asString(entry.sessionFile);
  if (sessionFile) {
    return [
      path.isAbsolute(sessionFile)
        ? path.resolve(sessionFile)
        : path.resolve(sessionsDir, sessionFile),
    ];
  }
  const sessionId = asString(entry.sessionId);
  return sessionId ? [path.join(sessionsDir, `${sessionId}.jsonl`)] : [];
};

const collectOpenClawSessionFileRefs = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectOpenClawSessionFileRefs(entry));
  }
  if (!isRecord(value)) return [];
  const out: string[] = [];
  const sessionFile = asString(value.sessionFile);
  if (sessionFile) out.push(sessionFile);
  for (const child of Object.values(value)) {
    if (child !== value) out.push(...collectOpenClawSessionFileRefs(child));
  }
  return out;
};

export const runThirdPartyMigration = async (opts: {
  source: ThirdPartyMigrationSource;
  sourceRoot?: string;
  stellaHome: string;
  selection?: ThirdPartyMigrationSelection;
  db?: SqliteDatabase;
  now?: Date;
}): Promise<ThirdPartyMigrationReport> => {
  const sourceRoot = path.resolve(
    opts.sourceRoot ?? resolveDefaultMigrationSourceRoot(opts.source),
  );
  const stellaHome = path.resolve(opts.stellaHome);
  const selected = { ...DEFAULT_OPTIONS, ...(opts.selection ?? {}) };
  const startedAt = opts.now ?? new Date();
  const paths = await collectSourcePaths(opts.source, sourceRoot);
  const importState = await readImportState(stellaHome);
  const key = sourceKey(opts.source, sourceRoot);
  const items: ThirdPartyMigrationReportItem[] = [];
  const ownsDb = !opts.db;
    const db = opts.db ?? await createMigrationDatabase(stellaHome);

  try {
    if (!(await pathExists(sourceRoot))) {
      items.push({
        kind: "source",
        status: "error",
        source: sourceRoot,
        message: `${PRODUCT_LABELS[opts.source]} was not found.`,
      });
    } else {
      if (selected.memory) {
        await importMemoryFiles({
          source: opts.source,
          target: "memory",
          files: paths.memoryFiles,
          db,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.user) {
        await importMemoryFiles({
          source: opts.source,
          target: "user",
          files: paths.userFiles,
          db,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.skills) {
        await importSkillDirs({
          source: opts.source,
          dirs: paths.skillDirs,
          stellaHome,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.personality) {
        await importPersonalityFiles({
          source: opts.source,
          files: paths.personalityFiles,
          stellaHome,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.modelConfig) {
        await importModelConfig({
          source: opts.source,
          files: paths.modelConfigFiles,
          stellaHome,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.sessionHistory) {
        await importSessionHistory({
          source: opts.source,
          sourceRoot,
          paths,
          db,
          state: importState,
          stateKey: key,
          items,
        });
      }
      if (selected.schedules) {
        await importSchedules({
          source: opts.source,
          files: paths.scheduleFiles,
          stellaHome,
          state: importState,
          stateKey: key,
          items,
        });
      }
    }

    items.push({
      kind: "channels",
      status: "skipped",
      message:
        "Channels skipped - re-enable in Stella settings (no setup required).",
    });

    await writeImportState(stellaHome, importState);
    const report = await writeMarkdownReport({
      source: opts.source,
      sourceRoot,
      stellaHome,
      startedAt,
      items,
    });
    return report;
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
};

const createMigrationDatabase = async (
  stellaHome: string,
): Promise<SqliteDatabase> => {
  const Database = await loadSqliteDatabaseCtor();
  const db = new Database(getDesktopDatabasePath(stellaHome), {
    timeout: 5_000,
  });
  initializeDesktopDatabase(db);
  return db;
};

const importMemoryFiles = async (args: {
  source: ThirdPartyMigrationSource;
  target: "memory" | "user";
  files: string[];
  db: SqliteDatabase;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  if (args.files.length === 0) {
    args.items.push({
      kind: args.target,
      status: "skipped",
      message: `No ${args.target === "memory" ? "memory" : "user profile"} file found.`,
    });
    return;
  }

  const existingRows = args.db
    .prepare("SELECT content FROM memory_entries WHERE target = ? ORDER BY rowid ASC")
    .all(args.target) as Array<{ content?: string }>;
  const existing = new Set(
    existingRows
      .map((row) => row.content)
      .filter((value): value is string => typeof value === "string")
      .map(normalizeText),
  );
  let added = 0;
  let duplicates = 0;
  const now = Date.now();
  const insert = args.db.prepare(`
    INSERT INTO memory_entries (id, target, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const file of args.files) {
    const text = await readTextIfExists(file);
    if (!text) continue;
    const fingerprint = hashText(text);
    const itemId = `${args.target}:${file}`;
    if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) {
      duplicates += 1;
      continue;
    }
    const entries = extractMarkdownEntries(text);
    for (const entry of entries) {
      const normalized = normalizeText(entry);
      if (!normalized || existing.has(normalized)) {
        duplicates += 1;
        continue;
      }
      insert.run(generateLocalId(), args.target, entry, now, now);
      existing.add(normalized);
      added += 1;
    }
    markImported(args.state, args.stateKey, itemId, fingerprint);
  }

  args.items.push({
    kind: args.target,
    status: added > 0 ? "imported" : "skipped",
    count: added,
    source: args.files.join(", "),
    target: "stella.sqlite:memory_entries",
    message:
      added > 0
        ? `Imported ${added} ${args.target} entr${added === 1 ? "y" : "ies"} (${duplicates} already present).`
        : `No new ${args.target} entries to import.`,
  });
};

const extractMarkdownEntries = (text: string): string[] => {
  if (text.includes(ENTRY_DELIMITER)) {
    return text
      .split(ENTRY_DELIMITER)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const entries: string[] = [];
  const headings: string[] = [];
  let paragraphLines: string[] = [];
  let inCodeBlock = false;

  const contextPrefix = () =>
    headings
      .filter((heading) => !/\b(MEMORY|USER|SOUL|AGENTS|TOOLS|IDENTITY)\.md\b/i.test(heading))
      .join(" > ");

  const pushEntry = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const prefix = contextPrefix();
    entries.push(prefix ? `${prefix}: ${trimmed}` : trimmed);
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    pushEntry(paragraphLines.map((line) => line.trim()).join(" "));
    paragraphLines = [];
  };

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, "");
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      flushParagraph();
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const heading = stripped.match(/^(#{1,6})\s+(.*\S)\s*$/u);
    if (heading) {
      flushParagraph();
      const level = heading[1]?.length ?? 1;
      while (headings.length >= level) headings.pop();
      headings.push(heading[2]?.trim() ?? "");
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)\s*$/u);
    if (bullet) {
      flushParagraph();
      pushEntry(bullet[1] ?? "");
      continue;
    }
    if (!stripped) {
      flushParagraph();
      continue;
    }
    if (stripped.startsWith("|") && stripped.endsWith("|")) {
      flushParagraph();
      continue;
    }
    paragraphLines.push(stripped);
  }
  flushParagraph();

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const normalized = normalizeText(entry);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const importSkillDirs = async (args: {
  source: ThirdPartyMigrationSource;
  dirs: string[];
  stellaHome: string;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  if (args.dirs.length === 0) {
    args.items.push({ kind: "skills", status: "skipped", message: "No skills found." });
    return;
  }
  const skillsRoot = path.join(args.stellaHome, "skills");
  await fsp.mkdir(skillsRoot, { recursive: true });
  let imported = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const dir of args.dirs) {
    const fingerprint = await hashPath(dir);
    const itemId = `skill:${dir}`;
    if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) {
      skipped += 1;
      continue;
    }
    const slug = `${args.source}-${sanitizeSkillSlug(path.basename(dir))}`;
    const target = path.join(skillsRoot, slug);
    if (await pathExists(target)) {
      conflicts += 1;
      args.items.push({
        kind: "skills",
        status: "manual",
        source: dir,
        target,
        message: "A Stella skill with the import name already exists; review before replacing it.",
      });
      continue;
    }
    await copyDirectoryRegularFiles(dir, target);
    await ensureImportedSkillHeader(target, PRODUCT_LABELS[args.source]);
    markImported(args.state, args.stateKey, itemId, fingerprint);
    imported += 1;
  }

  args.items.push({
    kind: "skills",
    status: imported > 0 ? "imported" : "skipped",
    count: imported,
    target: skillsRoot,
    message: `Imported ${imported} skill${imported === 1 ? "" : "s"}. Already imported: ${skipped}. Need review: ${conflicts}. Review imported skills from Store when you are ready to publish.`,
  });
};

const sanitizeSkillSlug = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
};

const copyDirectoryRegularFiles = async (
  sourceDir: string,
  targetDir: string,
): Promise<void> => {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRegularFiles(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
};

const ensureImportedSkillHeader = async (
  skillDir: string,
  sourceLabel: string,
): Promise<void> => {
  const skillPath = path.join(skillDir, "SKILL.md");
  const content = await readTextIfExists(skillPath);
  if (!content) return;
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const parsed = frontmatter ? parseYamlSafely(frontmatter[1] ?? "") : null;
  const title =
    asString(isRecord(parsed) ? parsed.name : null) ??
    body.match(/^\s*#\s+(.+)$/mu)?.[1]?.trim() ??
    path.basename(skillDir);
  const description =
    asString(isRecord(parsed) ? parsed.description : null) ??
    `Imported ${sourceLabel} skill.`;
  const next = [
    "---",
    `name: ${formatSkillFrontmatterValue(title)}`,
    `description: ${formatSkillFrontmatterValue(description)}`,
    "---",
    "",
    body.trimStart(),
  ].join("\n");
  await fsp.writeFile(skillPath, next, "utf-8");
};

const parseYamlSafely = (text: string): unknown => {
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
};

const formatSkillFrontmatterValue = (value: string): string => {
  const normalized = value.trim().replace(/\r?\n/gu, " ");
  if (/^[A-Za-z0-9][A-Za-z0-9 ._()/-]*$/u.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
};

const importPersonalityFiles = async (args: {
  source: ThirdPartyMigrationSource;
  files: string[];
  stellaHome: string;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  if (args.files.length === 0) {
    args.items.push({
      kind: "personality",
      status: "skipped",
      message: "No personality file found.",
    });
    return;
  }
  const target = getPersonalityFilePath(args.stellaHome);
  ensurePrivateDirSync(path.dirname(target));
  let existing = await readTextIfExists(target);
  existing ??= "";
  let added = 0;
  const blocks: string[] = [];
  for (const file of args.files) {
    const text = await readTextIfExists(file);
    if (!text?.trim()) continue;
    const fingerprint = hashText(text);
    const itemId = `personality:${file}`;
    if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) continue;
    const marker = `third-party-import:${args.source}:${hashText(file).slice(0, 12)}`;
    if (existing.includes(marker)) continue;
    blocks.push(
      [
        `<!-- ${marker} -->`,
        `## Imported ${PRODUCT_LABELS[args.source]} Personality`,
        "",
        text.trim(),
        `<!-- /${marker} -->`,
      ].join("\n"),
    );
    markImported(args.state, args.stateKey, itemId, fingerprint);
    added += 1;
  }
  if (blocks.length > 0) {
    const next = [existing.trim(), ...blocks].filter(Boolean).join("\n\n") + "\n";
    await fsp.writeFile(target, next, "utf-8");
  }
  args.items.push({
    kind: "personality",
    status: added > 0 ? "imported" : "skipped",
    count: added,
    source: args.files.join(", "),
    target,
    message: added > 0 ? `Imported ${added} personality file${added === 1 ? "" : "s"}.` : "No new personality content to import.",
  });
};

const importModelConfig = async (args: {
  source: ThirdPartyMigrationSource;
  files: string[];
  stellaHome: string;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  if (args.files.length === 0) {
    args.items.push({
      kind: "modelConfig",
      status: "skipped",
      message: "No model configuration found.",
    });
    return;
  }
  const first = args.files[0]!;
  const text = await readTextIfExists(first);
  if (!text) {
    args.items.push({
      kind: "modelConfig",
      status: "skipped",
      source: first,
      message: "Model config was empty or unreadable.",
    });
    return;
  }
  const fingerprint = hashText(text);
  const itemId = `model-config:${first}`;
  if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) {
    args.items.push({
      kind: "modelConfig",
      status: "skipped",
      source: first,
      message: "Model config was already imported.",
    });
    return;
  }

  const model = args.source === "hermes"
    ? extractHermesModelConfig(text)
    : await extractOpenClawModelConfig(text);
  if (!model) {
    args.items.push({
      kind: "modelConfig",
      status: "manual",
      source: first,
      message: "Could not identify a provider/model value; review the source config manually.",
    });
    return;
  }
  const prefs = loadLocalPreferences(args.stellaHome);
  saveLocalPreferences(args.stellaHome, {
    ...prefs,
    modelOverrides: {
      ...prefs.modelOverrides,
      orchestrator: model,
      general: model,
    },
  });
  markImported(args.state, args.stateKey, itemId, fingerprint);
  args.items.push({
    kind: "modelConfig",
    status: "imported",
    source: first,
    target: path.join(args.stellaHome, "preferences.json"),
    message: `Set Stella Assistant and General agent model to ${model}. OAuth/API keys still need review in Settings if Stella cannot reuse them automatically.`,
  });
};

const extractHermesModelConfig = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const model = parsed.model;
  if (typeof model === "string") return model.trim() || null;
  if (isRecord(model)) {
    return (
      asString(model.default) ??
      asString(model.primary) ??
      asString(model.current) ??
      asString(model.model)
    );
  }
  return asString(parsed.default_model) ?? asString(parsed.model_default);
};

const extractOpenClawModelConfig = async (text: string): Promise<string | null> => {
  const parsed = await parseJsonLikeText(text);
  if (!isRecord(parsed)) return null;
  const defaults = isRecord(parsed.agents) && isRecord(parsed.agents.defaults)
    ? parsed.agents.defaults
    : null;
  if (!defaults) return null;
  const rawModel = isRecord(defaults.model)
    ? asString(defaults.model.primary) ?? asString(defaults.model.default)
    : asString(defaults.model);
  if (!rawModel) return null;
  const catalog = isRecord(defaults.models) ? defaults.models : {};
  if (Object.hasOwn(catalog, rawModel)) return rawModel;
  for (const [modelId, value] of Object.entries(catalog)) {
    if (typeof value === "string" && value === rawModel) return modelId;
    if (isRecord(value) && asString(value.alias) === rawModel) return modelId;
  }
  return rawModel;
};

const importSessionHistory = async (args: {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  paths: SourcePaths;
  db: SqliteDatabase;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  const sessionStore = new SessionStore(args.db);
  const sessions =
    args.source === "hermes"
      ? await loadHermesSessions(args.paths.hermesStateDb)
      : await loadOpenClawSessions(
          args.paths.openClawSessionFiles,
          args.sourceRoot,
        );
  if (sessions.length === 0) {
    args.items.push({
      kind: "sessionHistory",
      status: "skipped",
      message: "No importable session history found.",
    });
    return;
  }

  let imported = 0;
  for (const session of sessions.slice(0, MAX_IMPORTED_SESSIONS)) {
    const visibleMessages = session.messages.filter((message) =>
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult",
    );
    if (visibleMessages.length === 0) continue;
    const fingerprint = hashText(
      JSON.stringify({ ...session, messages: visibleMessages }),
    );
    const itemId = `session:${session.id}`;
    if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) continue;
    const threadKey = `import:${args.source}:${session.id}`;
    for (const message of visibleMessages.slice(0, MAX_IMPORTED_SESSION_MESSAGES)) {
      sessionStore.appendThreadMessage({
        threadKey,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      });
    }
    markImported(args.state, args.stateKey, itemId, fingerprint);
    imported += 1;
  }

  args.items.push({
    kind: "sessionHistory",
    status: imported > 0 ? "imported" : "skipped",
    count: imported,
    target: "stella.sqlite:runtime_thread_entries",
    message: imported > 0
      ? `Imported ${imported} session${imported === 1 ? "" : "s"} as Stella history threads.`
      : "Session history was already imported.",
  });
};

const loadHermesSessions = async (
  stateDbPath: string | undefined,
): Promise<SourceSession[]> => {
  if (!stateDbPath || !(await pathExists(stateDbPath))) return [];
  let db: SqliteDatabase | null = null;
  try {
    const Database = await loadSqliteDatabaseCtor();
    db = new Database(stateDbPath, { readOnly: true, readonly: true });
    const rows = db
      .prepare(
        "SELECT id, started_at AS startedAt FROM sessions ORDER BY started_at DESC LIMIT ?",
      )
      .all(MAX_IMPORTED_SESSIONS) as Array<{ id: string; startedAt?: number }>;
    return rows.map((row) => {
      const messages = db!
        .prepare(
          "SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?",
        )
        .all(row.id, MAX_IMPORTED_SESSION_MESSAGES) as Array<{
          role?: string;
          content?: string;
          timestamp?: number;
        }>;
      return {
        id: sanitizeImportedSessionId(row.id),
        timestamp: typeof row.startedAt === "number" ? row.startedAt * 1000 : Date.now(),
        messages: messages.flatMap((message) => normalizeSourceMessage(message)),
      };
    }).filter((session) => session.messages.length > 0);
  } catch {
    return [];
  } finally {
    db?.close();
  }
};

const loadOpenClawSessions = async (
  files: string[],
  sourceRoot: string,
): Promise<SourceSession[]> => {
  const sessions: SourceSession[] = [];
  for (const file of files.slice(0, MAX_IMPORTED_SESSIONS)) {
    const text = await readTextIfExists(file);
    if (!text) continue;
    const messages: SourceSessionMessage[] = [];
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        messages.push(...normalizeSourceMessage(parsed));
      } catch {}
    }
    if (messages.length > 0) {
      const relativeSessionPath = path
        .relative(sourceRoot, file)
        .replace(/\.jsonl$/iu, "");
      sessions.push({
        id: sanitizeImportedSessionId(relativeSessionPath),
        timestamp: messages[0]?.timestamp ?? Date.now(),
        messages,
      });
    }
  }
  return sessions;
};

const normalizeSourceMessage = (value: unknown): SourceSessionMessage[] => {
  if (!isRecord(value)) return [];
  const nested = isRecord(value.message) ? value.message : value;
  const rawRole = asString(nested.role) ?? asString(value.role);
  const contentValue = nested.content ?? value.content ?? nested.text ?? value.text;
  const content = typeof contentValue === "string"
    ? contentValue
    : Array.isArray(contentValue)
      ? contentValue
          .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
          .join("\n")
      : null;
  if (!rawRole || !content?.trim()) return [];
  const role =
    rawRole === "assistant" ? "assistant" :
    rawRole === "user" ? "user" :
    rawRole === "tool" || rawRole === "toolResult" ? "toolResult" :
    null;
  if (!role) return [];
  const timestampRaw = Number(nested.timestamp ?? value.timestamp ?? value.createdAt);
  return [{
    role,
    content: content.trim(),
    timestamp: Number.isFinite(timestampRaw)
      ? timestampRaw > 10_000_000_000 ? timestampRaw : timestampRaw * 1000
      : Date.now(),
  }];
};

const sanitizeImportedSessionId = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120) || generateLocalId();

const importSchedules = async (args: {
  source: ThirdPartyMigrationSource;
  files: string[];
  stellaHome: string;
  state: ImportedState;
  stateKey: string;
  items: ThirdPartyMigrationReportItem[];
}): Promise<void> => {
  if (args.files.length === 0) {
    args.items.push({
      kind: "schedules",
      status: "skipped",
      message: "No compatible schedules found.",
    });
    return;
  }
  const target = path.join(args.stellaHome, "local-scheduler.json");
  const sourceFile = args.files[0]!;
  const parsed = await readJsonLikeIfExists(sourceFile);
  const jobs = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  if (jobs.length === 0) {
    args.items.push({
      kind: "schedules",
      status: "skipped",
      source: sourceFile,
      message: "Schedule file did not contain importable jobs.",
    });
    return;
  }
  const scheduler = new LocalSchedulerService({
    stellaHome: args.stellaHome,
    runnerTarget: migrationSchedulerRunnerTarget,
  });
  scheduler.start();
  scheduler.stop();
  let imported = 0;
  let invalid = 0;
  for (const job of jobs) {
    if (!isRecord(job)) continue;
    const id = asString(job.id) ?? hashText(JSON.stringify(job)).slice(0, 12);
    const label = asString(job.name) ?? id;
    const fingerprint = hashText(JSON.stringify(job));
    const itemId = `schedule:${id}`;
    if (alreadyImported(args.state, args.stateKey, itemId, fingerprint)) continue;
    const input = createImportedCronJobInput(args.source, job);
    if (!input) {
      invalid += 1;
      args.items.push({
        kind: "schedules",
        status: "manual",
        source: sourceFile,
        message: `Skipped schedule "${label}" because it did not include a compatible schedule and payload.`,
      });
      continue;
    }
    try {
      scheduler.addCronJob(input);
    } catch (error) {
      invalid += 1;
      args.items.push({
        kind: "schedules",
        status: "manual",
        source: sourceFile,
        message: `Skipped schedule "${label}" because Stella could not validate it: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    markImported(args.state, args.stateKey, itemId, fingerprint);
    imported += 1;
  }
  args.items.push({
    kind: "schedules",
    status: imported > 0 ? "imported" : invalid > 0 ? "manual" : "skipped",
    source: sourceFile,
    target,
    count: imported,
    message: imported > 0
      ? invalid > 0
        ? `Imported ${imported} validated schedule${imported === 1 ? "" : "s"}. Need review: ${invalid}.`
        : `Imported ${imported} validated schedule${imported === 1 ? "" : "s"}.`
      : invalid > 0
        ? "Schedules need manual review before Stella can import them."
        : "Schedules were already imported.",
  });
};

const migrationSchedulerRunnerTarget: StellaHostRunnerTarget = {
  getRunner: () => null,
};

const createImportedCronJobInput = (
  source: ThirdPartyMigrationSource,
  job: Record<string, unknown>,
): LocalCronJobCreateInput | null => {
  const schedule = parseImportedSchedule(job);
  const payload = parseImportedSchedulePayload(job);
  if (!schedule || !payload) return null;
  return {
    conversationId: "imported-schedules",
    name: asString(job.name) ?? `Imported ${PRODUCT_LABELS[source]} schedule`,
    description: `Imported from ${PRODUCT_LABELS[source]}.`,
    enabled: job.enabled !== false,
    schedule,
    payload,
  };
};

const parseImportedSchedule = (
  job: Record<string, unknown>,
): LocalCronSchedule | null => {
  const schedule = job.schedule;
  if (isRecord(schedule)) {
    const kind = asString(schedule.kind);
    if (kind === "cron") {
      const expr = asString(schedule.expr);
      if (!expr) return null;
      const tz = asString(schedule.tz);
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }
    if (kind === "every" && typeof schedule.everyMs === "number") {
      const anchorMs = typeof schedule.anchorMs === "number"
        ? schedule.anchorMs
        : undefined;
      return anchorMs === undefined
        ? { kind: "every", everyMs: schedule.everyMs }
        : { kind: "every", everyMs: schedule.everyMs, anchorMs };
    }
    if (kind === "at") {
      const atMs = typeof schedule.atMs === "number"
        ? schedule.atMs
        : Date.parse(asString(schedule.at) ?? "");
      return Number.isFinite(atMs) ? { kind: "at", atMs } : null;
    }
    return null;
  }
  const cron = asString(job.cron) ?? asString(schedule);
  return cron ? { kind: "cron", expr: cron } : null;
};

const parseImportedSchedulePayload = (
  job: Record<string, unknown>,
): LocalCronJobCreateInput["payload"] | null => {
  const prompt =
    asString(job.prompt) ??
    asString(job.message) ??
    asString(job.command);
  if (prompt) return { kind: "agent", prompt };
  if (isRecord(job.payload)) {
    if (job.payload.kind === "agentTurn") {
      const message = asString(job.payload.message);
      return message ? { kind: "agent", prompt: message } : null;
    }
    if (job.payload.kind === "systemEvent") {
      const text = asString(job.payload.text) ?? asString(job.payload.message);
      return text ? { kind: "notify", text } : null;
    }
  }
  return null;
};

const writeMarkdownReport = async (args: {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  stellaHome: string;
  startedAt: Date;
  items: ThirdPartyMigrationReportItem[];
}): Promise<ThirdPartyMigrationReport> => {
  const completedAt = new Date();
  const reportDir = path.join(args.stellaHome, REPORTS_DIR);
  await fsp.mkdir(reportDir, { recursive: true });
  const fileName = `${completedAt.toISOString().replace(/[:.]/g, "-")}-${args.source}-import.md`;
  const markdownPath = path.join(reportDir, fileName);
  const label = PRODUCT_LABELS[args.source];
  const grouped = (status: ThirdPartyMigrationReportItem["status"]) =>
    args.items.filter((item) => item.status === status);
  const lines = [
    `# Import from ${label} Report`,
    "",
    `- Source: \`${args.sourceRoot}\``,
    `- Stella home: \`${args.stellaHome}\``,
    `- Started: ${args.startedAt.toISOString()}`,
    `- Completed: ${completedAt.toISOString()}`,
    `- Source project: [${label}](${PRODUCT_REPOS[args.source]})`,
    "",
    "## Imported",
    "",
    ...formatReportItems(grouped("imported")),
    "",
    "## Skipped",
    "",
    ...formatReportItems(grouped("skipped")),
    "",
    "## Needs Manual Attention",
    "",
    ...formatReportItems([...grouped("manual"), ...grouped("error")]),
    "",
    "## Notes",
    "",
    "- Channel pairings were not migrated. Channels skipped - re-enable in Stella settings (no setup required).",
    "- The import is one-time. Stella does not bridge to or sync with the old engine.",
    "- The source product files were read only.",
  ];
  await fsp.writeFile(markdownPath, lines.join("\n") + "\n", "utf-8");
  const report: ThirdPartyMigrationReport = {
    source: args.source,
    sourceRoot: args.sourceRoot,
    stellaHome: args.stellaHome,
    startedAt: args.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    markdownPath,
    items: [
      ...args.items,
      {
        kind: "report",
        status: "imported",
        target: markdownPath,
        message: "Markdown migration report written.",
      },
    ],
  };
  return report;
};

const formatReportItems = (items: ThirdPartyMigrationReportItem[]): string[] => {
  if (items.length === 0) return ["- None."];
  return items.map((item) => {
    const count =
      typeof item.count === "number" ? ` Count: ${item.count}.` : "";
    const source = item.source ? ` Source: \`${item.source}\`.` : "";
    const target = item.target ? ` Target: \`${item.target}\`.` : "";
    return `- ${item.kind}: ${item.message}${count}${source}${target}`;
  });
};
