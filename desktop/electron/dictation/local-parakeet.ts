import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeHelperPath } from "../native-helper-path.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_ID = "parakeet-tdt-0.6b-v3-coreml";
const HELPER_NAME = "parakeet_transcriber";
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SERVICE_READY_TIMEOUT_MS = 120_000;

type HelperResponse = {
  ok: boolean;
  model: string;
  transcript?: string;
  error?: string;
  id?: string;
};

type LocalParakeetStatus = {
  available: boolean;
  model: string;
  reason?: string;
};

type PendingRequest = {
  resolve: (response: HelperResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let serviceProcess: ChildProcessWithoutNullStreams | null = null;
let serviceReady: Promise<void> | null = null;
let serviceBuffer = "";
const pendingRequests = new Map<string, PendingRequest>();

const runHelper = (
  args: string[],
  timeout: number,
): Promise<HelperResponse> => {
  const helperPath = resolveNativeHelperPath(HELPER_NAME);
  if (!helperPath) {
    return Promise.resolve({
      ok: false,
      model: MODEL_ID,
      error: "Local Parakeet helper is not installed.",
    });
  }

  return new Promise((resolve) => {
    execFile(
      helperPath,
      [...args, "--cache-root", parakeetCacheRoot()],
      {
        timeout,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const raw = stdout.trim();
        const parsed = parseHelperResponse(raw);
        if (parsed) {
          resolve(parsed);
          return;
        }
        resolve({
          ok: false,
          model: MODEL_ID,
          error: error?.message || raw || "Local Parakeet helper failed.",
        });
      },
    );
  });
};

const parseHelperResponse = (raw: string): HelperResponse | null => {
  if (!raw) return null;
  const lastLine = raw.split(/\r?\n/).at(-1);
  if (!lastLine) return null;
  try {
    return JSON.parse(lastLine) as HelperResponse;
  } catch {
    return null;
  }
};

const parakeetCacheRoot = (): string => {
  const sourceCandidates = process.env.NODE_ENV === "development" || !process.defaultApp
    ? [
        path.join(process.cwd(), "resources", "parakeet"),
        path.join(process.cwd(), "desktop", "resources", "parakeet"),
        path.join(__dirname, "..", "..", "..", "..", "resources", "parakeet"),
        path.join(__dirname, "..", "..", "..", "resources", "parakeet"),
        path.join(__dirname, "..", "..", "resources", "parakeet"),
        path.join(__dirname, "..", "resources", "parakeet"),
      ]
    : [
        path.join(process.resourcesPath, "parakeet"),
      ];
  for (const candidate of sourceCandidates) {
    if (hasParakeetModel(candidate)) {
      return candidate;
    }
  }
  return sourceCandidates[0] ?? path.join(process.resourcesPath, "parakeet");
};

const hasParakeetModel = (candidate: string): boolean => {
  try {
    return path.isAbsolute(candidate)
      && existsSync(
        path.join(
          candidate,
          "FluidAudio",
          "Models",
          "parakeet-tdt-0.6b-v3",
          "config.json",
        ),
      );
  } catch {
    return false;
  }
};

const startService = async (): Promise<void> => {
  if (serviceReady) return serviceReady;
  const helperPath = resolveNativeHelperPath(HELPER_NAME);
  if (!helperPath) {
    throw new Error("Local Parakeet helper has not been built.");
  }

  serviceReady = new Promise((resolve, reject) => {
    const child = spawn(
      helperPath,
      ["--serve", "--cache-root", parakeetCacheRoot()],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    serviceProcess = child;

    const readyTimeout = setTimeout(() => {
      reject(new Error("Local Parakeet helper did not become ready."));
      stopService();
    }, SERVICE_READY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      serviceBuffer += chunk;
      let newlineIndex = serviceBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = serviceBuffer.slice(0, newlineIndex).trim();
        serviceBuffer = serviceBuffer.slice(newlineIndex + 1);
        handleServiceLine(line, resolve, readyTimeout);
        newlineIndex = serviceBuffer.indexOf("\n");
      }
    });

    child.once("error", (error) => {
      clearTimeout(readyTimeout);
      reject(error);
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
    });

    child.once("exit", (code, signal) => {
      clearTimeout(readyTimeout);
      const error = new Error(
        `Local Parakeet helper exited (${signal ?? code ?? "unknown"}).`,
      );
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
      serviceBuffer = "";
    });
  });

  return serviceReady;
};

const handleServiceLine = (
  line: string,
  readyResolve: () => void,
  readyTimeout: ReturnType<typeof setTimeout>,
) => {
  const parsed = parseHelperResponse(line);
  if (!parsed) return;
  if (!parsed.id) {
    if (parsed.ok) {
      clearTimeout(readyTimeout);
      readyResolve();
    }
    return;
  }
  const pending = pendingRequests.get(parsed.id);
  if (!pending) return;
  pendingRequests.delete(parsed.id);
  clearTimeout(pending.timeout);
  pending.resolve(parsed);
};

const failPending = (error: Error) => {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRequests.clear();
};

const stopService = () => {
  if (!serviceProcess) return;
  serviceProcess.kill();
  serviceProcess = null;
  serviceReady = null;
};

const transcribeWithService = async (audioPath: string): Promise<HelperResponse> => {
  await startService();
  const child = serviceProcess;
  if (!child || child.stdin.destroyed) {
    throw new Error("Local Parakeet helper is not running.");
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Local Parakeet transcription timed out."));
    }, TRANSCRIBE_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, audioPath })}\n`);
  });
};

export const warmLocalParakeet = async (): Promise<LocalParakeetStatus> => {
  const status = await getLocalParakeetStatus();
  if (!status.available) return status;
  try {
    await startService();
    return { available: true, model: MODEL_ID };
  } catch (error) {
    return {
      available: false,
      model: MODEL_ID,
      reason: (error as Error).message,
    };
  }
};

export const getLocalParakeetStatus = async (): Promise<LocalParakeetStatus> => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return {
      available: false,
      model: MODEL_ID,
      reason: "Local Parakeet dictation requires macOS on Apple Silicon.",
    };
  }
  const helperPath = resolveNativeHelperPath(HELPER_NAME);
  if (!helperPath) {
    return {
      available: false,
      model: MODEL_ID,
      reason: "Local Parakeet helper has not been built.",
    };
  }
  const result = await runHelper(["--probe"], 10_000);
  return {
    available: result.ok,
    model: MODEL_ID,
    reason: result.ok ? undefined : result.error,
  };
};

export const transcribeWithLocalParakeet = async (
  wavBase64: string,
): Promise<{ transcript: string; model: string }> => {
  const status = await getLocalParakeetStatus();
  if (!status.available) {
    throw new Error(status.reason ?? "Local Parakeet dictation is unavailable.");
  }

  const tempDir = path.join(os.tmpdir(), "stella-dictation");
  await mkdir(tempDir, { recursive: true });
  const audioPath = path.join(tempDir, `${randomUUID()}.wav`);
  try {
    await writeFile(audioPath, Buffer.from(wavBase64, "base64"));
    const result = await transcribeWithService(audioPath);
    if (!result.ok) {
      throw new Error(result.error ?? "Local Parakeet transcription failed.");
    }
    return {
      transcript: result.transcript ?? "",
      model: result.model || MODEL_ID,
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => undefined);
  }
};
