#!/usr/bin/env node

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { arch, platform } from "os";
import { basename, dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const PREVIEW_ROOT_DIRNAME = "office-previews";
const PREVIEW_MANIFEST_NAME = "session.json";
const PREVIEW_HTML_NAME = "preview.html";
const PREVIEW_REF_MARKER = "__STELLA_OFFICE_PREVIEW_REF__";
const DEFAULT_PREVIEW_INTERVAL_MS = 1_500;
const MIN_PREVIEW_INTERVAL_MS = 500;

function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case "darwin":
      osKey = "darwin";
      break;
    case "linux":
      osKey = "linux";
      break;
    case "win32":
      osKey = "win32";
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case "x64":
    case "x86_64":
      archKey = "x64";
      break;
    case "arm64":
    case "aarch64":
      archKey = "arm64";
      break;
    default:
      return null;
  }

  const ext = os === "win32" ? ".exe" : "";
  return `stella-office-${osKey}-${archKey}${ext}`;
}

function ensureExecutable(binaryPath) {
  if (platform() === "win32") {
    return;
  }

  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    chmodSync(binaryPath, 0o755);
  }
}

function getBinaryPath() {
  const binaryName = getBinaryName();
  if (!binaryName) {
    throw new Error(`Unsupported platform: ${platform()}-${arch()}`);
  }

  const binaryPath = join(__dirname, binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `No stella-office binary found for ${platform()}-${arch()}\nExpected: ${binaryPath}`,
    );
  }

  ensureExecutable(binaryPath);
  return binaryPath;
}

function resolveStateRoot() {
  const stateRoot = process.env.STELLA_STATE_DIR?.trim();
  if (!stateRoot) {
    throw new Error(
      "Inline office previews are only available from Stella's runtime shell.",
    );
  }
  return stateRoot;
}

function resolvePreviewSessionDir(sessionId) {
  return join(resolveStateRoot(), PREVIEW_ROOT_DIRNAME, sessionId);
}

function detectFormat(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".pptx") return "pptx";
  return null;
}

function writePreviewManifest(sessionDir, manifest) {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, PREVIEW_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseNumberOption(rawValue, flagName, fallback) {
  if (rawValue == null) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flagName} value: ${rawValue}`);
  }

  return Math.max(MIN_PREVIEW_INTERVAL_MS, Math.floor(parsed));
}

function parsePreviewCommandArgs(argv) {
  let filePath = "";
  let intervalMs = DEFAULT_PREVIEW_INTERVAL_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--interval-ms") {
      intervalMs = parseNumberOption(argv[index + 1], "--interval-ms", intervalMs);
      index += 1;
      continue;
    }
    if (!filePath) {
      filePath = arg;
      continue;
    }
    throw new Error(`Unknown preview argument: ${arg}`);
  }

  if (!filePath) {
    throw new Error("Usage: stella-office preview <file> [--interval-ms 1500]");
  }

  return {
    filePath: resolve(process.cwd(), filePath),
    intervalMs,
  };
}

function parseInternalPreviewArgs(argv) {
  const values = {
    binaryPath: "",
    sessionId: "",
    filePath: "",
    intervalMs: DEFAULT_PREVIEW_INTERVAL_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--binary") {
      values.binaryPath = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--session") {
      values.sessionId = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--file") {
      values.filePath = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--interval-ms") {
      values.intervalMs = parseNumberOption(value, "--interval-ms", values.intervalMs);
      index += 1;
      continue;
    }
    throw new Error(`Unknown internal preview argument: ${arg}`);
  }

  if (!values.binaryPath || !values.sessionId || !values.filePath) {
    throw new Error("Missing required internal preview arguments.");
  }

  return values;
}

function runNative(binaryPath, argv, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binaryPath, argv, {
      stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        OFFICECLI_SKIP_UPDATE: "1",
      },
    });

    let stdout = "";
    let stderr = "";

    if (options.captureOutput) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function renderPreviewHtml(binaryPath, filePath) {
  const result = await runNative(binaryPath, ["view", filePath, "html"], {
    captureOutput: true,
  });

  if (result.code !== 0) {
    const errorText = (result.stderr || result.stdout).trim();
    throw new Error(errorText || `stella-office exited with code ${result.code}`);
  }

  return result.stdout;
}

async function startPreviewSession(binaryPath, argv) {
  const { filePath, intervalMs } = parsePreviewCommandArgs(argv);
  if (!existsSync(filePath)) {
    throw new Error(`Preview source not found: ${filePath}`);
  }

  const sessionId = randomUUID();
  const sessionDir = resolvePreviewSessionDir(sessionId);
  const startedAt = Date.now();
  const title = basename(filePath);

  writePreviewManifest(sessionDir, {
    sessionId,
    title,
    sourcePath: filePath,
    format: detectFormat(filePath),
    startedAt,
    updatedAt: startedAt,
    status: "starting",
  });

  const child = spawn(
    process.execPath,
    [
      CURRENT_FILE_PATH,
      "__run-preview-session",
      "--binary",
      binaryPath,
      "--session",
      sessionId,
      "--file",
      filePath,
      "--interval-ms",
      String(intervalMs),
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        OFFICECLI_SKIP_UPDATE: "1",
      },
    },
  );
  child.unref();

  process.stdout.write(
    `${PREVIEW_REF_MARKER}${JSON.stringify({
      sessionId,
      title,
      sourcePath: filePath,
    })}\n`,
  );
  process.stdout.write(`Started inline office preview for ${title}.\n`);
}

async function runPreviewSession(argv) {
  const { binaryPath, sessionId, filePath, intervalMs } = parseInternalPreviewArgs(argv);
  const sessionDir = resolvePreviewSessionDir(sessionId);
  const htmlPath = join(sessionDir, PREVIEW_HTML_NAME);
  const existingManifestPath = join(sessionDir, PREVIEW_MANIFEST_NAME);

  let startedAt = Date.now();
  try {
    const existing = JSON.parse(readFileSync(existingManifestPath, "utf-8"));
    if (typeof existing.startedAt === "number" && Number.isFinite(existing.startedAt)) {
      startedAt = existing.startedAt;
    }
  } catch {
    startedAt = Date.now();
  }

  let stopped = false;
  let lastRenderedAt = -1;

  const persistStatus = (status, extra = {}) => {
    writePreviewManifest(sessionDir, {
      sessionId,
      title: basename(filePath),
      sourcePath: filePath,
      format: detectFormat(filePath),
      startedAt,
      updatedAt: Date.now(),
      status,
      ...extra,
    });
  };

  const handleStop = () => {
    stopped = true;
    persistStatus("stopped");
  };

  process.on("SIGINT", handleStop);
  process.on("SIGTERM", handleStop);

  while (!stopped) {
    try {
      const sourceStats = statSync(filePath);
      if (sourceStats.mtimeMs !== lastRenderedAt || !existsSync(htmlPath)) {
        const html = await renderPreviewHtml(binaryPath, filePath);
        writeFileSync(htmlPath, html, "utf-8");
        lastRenderedAt = sourceStats.mtimeMs;
        persistStatus("ready");
      }
    } catch (error) {
      persistStatus("error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(intervalMs);
  }
}

async function main() {
  const binaryPath = getBinaryPath();
  const argv = process.argv.slice(2);

  if (argv[0] === "preview") {
    await startPreviewSession(binaryPath, argv.slice(1));
    return;
  }

  if (argv[0] === "__run-preview-session") {
    await runPreviewSession(argv.slice(1));
    return;
  }

  const child = spawn(binaryPath, argv, {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      OFFICECLI_SKIP_UPDATE: "1",
    },
  });

  child.on("error", (error) => {
    console.error(`Error executing stella-office binary: ${error.message}`);
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(
    `Error executing stella-office: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
