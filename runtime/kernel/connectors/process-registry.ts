import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getConnectorStateRoot } from "./state.js";

const execFileAsync = promisify(execFile);
const PROCESS_RECORDS_DIRNAME = "processes";
const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_START_TOLERANCE_MS = 5_000;

export type ConnectorBridgeProcessRecord = {
  sessionId: string;
  pid: number;
  ownerPid: number;
  workerPid?: number;
  connectorId: string;
  displayName: string;
  command: string;
  args: string[];
  cwd?: string;
  startedAt: number;
  processGroup: boolean;
};

const processRecordsDir = (stellaRoot: string) =>
  path.join(getConnectorStateRoot(stellaRoot), PROCESS_RECORDS_DIRNAME);

const processRecordPath = (
  stellaRoot: string,
  sessionId: string,
  pid: number,
) => path.join(processRecordsDir(stellaRoot), `${pid}-${sessionId}.json`);

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForPidExit = async (
  pid: number,
  timeoutMs = PROCESS_EXIT_GRACE_MS,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(50);
  }
  return !isPidAlive(pid);
};

const stopWindowsProcessTree = async (pid: number) => {
  await new Promise<void>((resolve) => {
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
};

export const stopConnectorBridgeProcess = async (
  pid: number | undefined,
  options?: { processGroup?: boolean },
) => {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return;
  }
  if (process.platform === "win32") {
    await stopWindowsProcessTree(pid);
    return;
  }

  const target = options?.processGroup ? -pid : pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  if (await waitForPidExit(pid)) return;

  try {
    process.kill(target, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort stale connector cleanup.
    }
  }
};

export const writeConnectorBridgeProcessRecord = async (
  stellaRoot: string,
  record: ConnectorBridgeProcessRecord,
): Promise<string | null> => {
  try {
    const dir = processRecordsDir(stellaRoot);
    await fs.mkdir(dir, { recursive: true });
    const filePath = processRecordPath(
      stellaRoot,
      record.sessionId,
      record.pid,
    );
    await fs.writeFile(
      filePath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return filePath;
  } catch {
    return null;
  }
};

export const removeConnectorBridgeProcessRecord = async (
  filePath: string | null | undefined,
) => {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => undefined);
};

const parseProcessRecord = async (
  filePath: string,
): Promise<ConnectorBridgeProcessRecord | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as Partial<ConnectorBridgeProcessRecord>;
    const pid = parsed.pid;
    const ownerPid = parsed.ownerPid;
    const workerPid = parsed.workerPid;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      typeof ownerPid !== "number" ||
      !Number.isInteger(ownerPid) ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.connectorId !== "string" ||
      typeof parsed.command !== "string"
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      pid,
      ownerPid,
      ...(typeof workerPid === "number" && Number.isInteger(workerPid)
        ? { workerPid }
        : {}),
      connectorId: parsed.connectorId,
      displayName:
        typeof parsed.displayName === "string"
          ? parsed.displayName
          : parsed.connectorId,
      command: parsed.command,
      args: Array.isArray(parsed.args)
        ? parsed.args.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      startedAt:
        typeof parsed.startedAt === "number" &&
        Number.isFinite(parsed.startedAt)
          ? parsed.startedAt
          : 0,
      processGroup: parsed.processGroup === true,
    };
  } catch {
    return null;
  }
};

const getProcessCommandLine = async (pid: number): Promise<string | null> => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CommandLine }`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8", timeout: 5_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const parseWindowsProcessTimestamp = (value: unknown): number | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) return parsedDate;
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{3})?$/u,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const offsetMinutes = offset
    ? Number.parseInt(offset, 10)
    : -new Date().getTimezoneOffset();
  const utcMs = Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );
  return utcMs - offsetMinutes * 60_000;
};

const getWindowsProcessStartedAt = async (
  pid: number,
): Promise<number | null> => {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CreationDate }`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    return parseWindowsProcessTimestamp(stdout.trim());
  } catch {
    return null;
  }
};

const getProcessStartedAt = async (pid: number): Promise<number | null> => {
  if (process.platform === "win32") {
    return getWindowsProcessStartedAt(pid);
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 5_000 },
    );
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeNeedle = (value: string) =>
  value
    .replace(/\\/g, "/")
    .replace(/\.(?:cmd|bat|exe)$/i, "")
    .toLowerCase();

const processIdentityMatchesRecord = async (
  record: ConnectorBridgeProcessRecord,
) => {
  const commandLine = await getProcessCommandLine(record.pid);
  if (!commandLine) return false;
  const haystack = normalizeNeedle(commandLine);
  const command = normalizeNeedle(record.command);
  const basename = normalizeNeedle(path.basename(record.command));
  const commandMatches = Boolean(
    (command.length > 2 && haystack.includes(command)) ||
      (basename.length > 2 && haystack.includes(basename)),
  );
  if (!commandMatches || record.startedAt <= 0) return false;
  const startedAt = await getProcessStartedAt(record.pid);
  if (!startedAt) return false;
  return Math.abs(startedAt - record.startedAt) <= PROCESS_START_TOLERANCE_MS;
};

export const sweepStaleConnectorBridgeProcesses = async (
  stellaRoot: string,
  options?: { currentWorkerPid?: number },
): Promise<{ scanned: number; stopped: number; removed: number }> => {
  const dir = processRecordsDir(stellaRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { scanned: 0, stopped: 0, removed: 0 };
  }

  let scanned = 0;
  let stopped = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    scanned += 1;
    const filePath = path.join(dir, entry);
    const record = await parseProcessRecord(filePath);
    if (!record) {
      await removeConnectorBridgeProcessRecord(filePath);
      removed += 1;
      continue;
    }

    if (!isPidAlive(record.pid)) {
      await removeConnectorBridgeProcessRecord(filePath);
      removed += 1;
      continue;
    }

    const ownerAlive = isPidAlive(record.ownerPid);
    if (ownerAlive) {
      if (
        !record.workerPid ||
        (options?.currentWorkerPid &&
          record.workerPid === options.currentWorkerPid)
      ) {
        continue;
      }
    }

    if (!(await processIdentityMatchesRecord(record))) {
      await removeConnectorBridgeProcessRecord(filePath);
      removed += 1;
      continue;
    }

    await stopConnectorBridgeProcess(record.pid, {
      processGroup: record.processGroup,
    });
    await removeConnectorBridgeProcessRecord(filePath);
    stopped += 1;
    removed += 1;
  }

  return { scanned, stopped, removed };
};
