import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveNativeHelperPath } from "../native-helper-path.js";

const __dirname = import.meta.dirname;

/**
 * Local on-device dictation. Two engines back this depending on platform:
 *
 *  - "coreml"  — Apple Silicon. The Swift `parakeet_transcriber` helper runs
 *                parakeet-tdt-0.6b-v3 on the Neural Engine via FluidAudio/CoreML.
 *                Most power-efficient path; the CoreML model is auto-downloaded
 *                by FluidAudio into the helper's cache root.
 *  - "cpp"     — Windows + Intel macOS. The `parakeet_cpp_transcriber` helper
 *                (wraps parakeet.cpp / libparakeet) runs the same model on CPU
 *                from a GGUF we download + cache here. This closes the gap where
 *                those platforms previously had no local option and fell back to
 *                cloud STT.
 *
 * Both helpers speak the same newline-delimited JSON protocol, so everything
 * below the engine selection (the serve loop, request multiplexing, timeouts)
 * is shared.
 */

type Engine = "coreml" | "cpp";

const resolveEngine = (): Engine | null => {
  if (process.platform === "darwin" && process.arch === "arm64")
    return "coreml";
  if (process.platform === "win32" && process.arch === "x64") return "cpp";
  if (process.platform === "darwin" && process.arch === "x64") return "cpp";
  return null;
};

const COREML_MODEL_ID = "parakeet-tdt-0.6b-v3-coreml";
const COREML_HELPER_NAME = "parakeet_transcriber";

const CPP_MODEL_ID = "parakeet-tdt-0.6b-v3-gguf";
const CPP_HELPER_NAME = "parakeet_cpp_transcriber";
// q8_0 is near-lossless vs NeMo (WER 0) and matches the CoreML path's accuracy.
// Smaller quants exist (q4_k ≈ 643MB, q5_k ≈ 707MB) if download size becomes a
// concern; swapping is a one-line change to these three constants.
const CPP_MODEL_FILE = "tdt-0.6b-v3-q8_0.gguf";
const CPP_MODEL_URL =
  "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/tdt-0.6b-v3-q8_0.gguf";
const CPP_MODEL_SIZE = 940663680;
const CPP_MODEL_SHA256 =
  "4d69a4a6683f4f2d952bad794c1357ca6eb628027695b4699c5a9ad4cd07d757";

const MODEL_ID_BY_ENGINE: Record<Engine, string> = {
  coreml: COREML_MODEL_ID,
  cpp: CPP_MODEL_ID,
};
const HELPER_NAME_BY_ENGINE: Record<Engine, string> = {
  coreml: COREML_HELPER_NAME,
  cpp: CPP_HELPER_NAME,
};

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SERVICE_READY_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;
// Perf: stop an idle serve process after this long with no transcription so an
// unused/warmed-but-untouched model doesn't stay resident. The next dictation
// re-warms transparently because startService/warmLocalParakeet are idempotent.
const IDLE_EVICTION_MS = 5 * 60_000;

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
let idleEvictionTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRequests = new Map<string, PendingRequest>();

// Perf: (re)arm the idle-eviction timer on each transcription. A serve process
// the user warmed but never (or no longer) dictates with is torn down after
// IDLE_EVICTION_MS so the model stops occupying memory; re-warming on the next
// dictation is transparent (startService is idempotent).
const armIdleEviction = () => {
  if (idleEvictionTimer) clearTimeout(idleEvictionTimer);
  idleEvictionTimer = setTimeout(() => {
    idleEvictionTimer = null;
    if (pendingRequests.size > 0) {
      // A transcription is mid-flight (e.g. timer fired during a slow run);
      // re-arm rather than killing the process out from under it.
      armIdleEviction();
      return;
    }
    stopService();
  }, IDLE_EVICTION_MS);
  // Don't let the eviction timer keep the event loop / process alive on its own.
  idleEvictionTimer.unref?.();
};

const clearIdleEviction = () => {
  if (idleEvictionTimer) {
    clearTimeout(idleEvictionTimer);
    idleEvictionTimer = null;
  }
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

// ---------------------------------------------------------------------------
// CoreML (Apple Silicon) model location — auto-downloaded by FluidAudio.
// ---------------------------------------------------------------------------

const coremlCacheRoot = (): string => {
  const sourceCandidates =
    process.env.NODE_ENV === "development" || !process.defaultApp
      ? [
          path.join(process.cwd(), "resources", "parakeet"),
          path.join(process.cwd(), "desktop", "resources", "parakeet"),
          path.join(__dirname, "..", "..", "..", "..", "resources", "parakeet"),
          path.join(__dirname, "..", "..", "..", "resources", "parakeet"),
          path.join(__dirname, "..", "..", "resources", "parakeet"),
          path.join(__dirname, "..", "resources", "parakeet"),
        ]
      : [path.join(process.resourcesPath, "parakeet")];
  for (const candidate of sourceCandidates) {
    if (hasCoremlModel(candidate)) {
      return candidate;
    }
  }
  return sourceCandidates[0] ?? path.join(process.resourcesPath, "parakeet");
};

const hasCoremlModel = (candidate: string): boolean => {
  try {
    return (
      path.isAbsolute(candidate) &&
      existsSync(
        path.join(
          candidate,
          "FluidAudio",
          "Models",
          "parakeet-tdt-0.6b-v3",
          "config.json",
        ),
      )
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// parakeet.cpp GGUF model — downloaded + cached under userData.
// ---------------------------------------------------------------------------

let cppModelDownload: Promise<string> | null = null;

// The GGUF lives in the install tree under resources/parakeet-cpp/, mirroring
// the CoreML cache at resources/parakeet/. The launcher pre-downloads it there
// at install time (the "Preparing local dictation" step); the runtime download
// below is the fallback for dev runs or a skipped/failed install step.
const CPP_MODEL_DIR_NAME = "parakeet-cpp";

const hasCppModel = (dir: string): boolean => {
  try {
    return (
      path.isAbsolute(dir) &&
      statSync(path.join(dir, CPP_MODEL_FILE)).size === CPP_MODEL_SIZE
    );
  } catch {
    return false;
  }
};

const cppModelDir = (): string => {
  const candidates =
    process.env.NODE_ENV === "development" || !process.defaultApp
      ? [
          path.join(process.cwd(), "resources", CPP_MODEL_DIR_NAME),
          path.join(process.cwd(), "desktop", "resources", CPP_MODEL_DIR_NAME),
          path.join(
            __dirname,
            "..",
            "..",
            "..",
            "..",
            "resources",
            CPP_MODEL_DIR_NAME,
          ),
          path.join(
            __dirname,
            "..",
            "..",
            "..",
            "resources",
            CPP_MODEL_DIR_NAME,
          ),
          path.join(__dirname, "..", "..", "resources", CPP_MODEL_DIR_NAME),
          path.join(__dirname, "..", "resources", CPP_MODEL_DIR_NAME),
        ]
      : [path.join(process.resourcesPath, CPP_MODEL_DIR_NAME)];
  for (const candidate of candidates) {
    if (hasCppModel(candidate)) return candidate;
  }
  return candidates[0] ?? path.join(process.resourcesPath, CPP_MODEL_DIR_NAME);
};

const cppModelPath = (): string => path.join(cppModelDir(), CPP_MODEL_FILE);

const cppModelIsReady = (): string | null => {
  const dir = cppModelDir();
  return hasCppModel(dir) ? path.join(dir, CPP_MODEL_FILE) : null;
};

const verifyCppModel = async (target: string): Promise<boolean> => {
  try {
    const info = await stat(target);
    if (info.size !== CPP_MODEL_SIZE) return false;
  } catch {
    return false;
  }
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(target), hash);
    return hash.digest("hex") === CPP_MODEL_SHA256;
  } catch {
    return false;
  }
};

const downloadCppModel = async (): Promise<string> => {
  const target = cppModelPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.part`;
  try {
    const response = await fetch(CPP_MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed: HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tmp),
    );
    if (!(await verifyCppModel(tmp))) {
      throw new Error("Downloaded Parakeet model failed integrity check.");
    }
    await rename(tmp, target);
    return target;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
};

/**
 * Ensure the GGUF model is present, downloading once if needed. Concurrent
 * callers share a single in-flight download. Returns the resolved model path.
 */
const ensureCppModel = (): Promise<string> => {
  const ready = cppModelIsReady();
  if (ready) return Promise.resolve(ready);
  if (cppModelDownload) return cppModelDownload;
  cppModelDownload = downloadCppModel().finally(() => {
    cppModelDownload = null;
  });
  return cppModelDownload;
};

// ---------------------------------------------------------------------------
// Engine-specific spawn arguments.
// ---------------------------------------------------------------------------

const probeArgs = (engine: Engine): string[] =>
  engine === "coreml"
    ? ["--probe", "--cache-root", coremlCacheRoot()]
    : ["--probe"];

const serveArgs = async (engine: Engine): Promise<string[]> => {
  if (engine === "coreml") {
    return ["--serve", "--cache-root", coremlCacheRoot()];
  }
  const modelPath = cppModelIsReady();
  if (!modelPath) {
    // Kick the download so a later attempt succeeds, but don't block the serve
    // start (and therefore the user's first dictation) on a multi-hundred-MB
    // fetch — the renderer falls back to cloud STT until the model lands.
    void ensureCppModel().catch(() => undefined);
    throw new Error("Local Parakeet model is still downloading.");
  }
  return ["--serve", "--model", modelPath];
};

// ---------------------------------------------------------------------------
// Shared helper invocation + serve loop.
// ---------------------------------------------------------------------------

const runProbe = (engine: Engine): Promise<HelperResponse> => {
  const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
  if (!helperPath) {
    return Promise.resolve({
      ok: false,
      model: MODEL_ID_BY_ENGINE[engine],
      error: "Local Parakeet helper is not installed.",
    });
  }

  return new Promise((resolve) => {
    execFile(
      helperPath,
      probeArgs(engine),
      {
        timeout: PROBE_TIMEOUT_MS,
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
          model: MODEL_ID_BY_ENGINE[engine],
          error: error?.message || raw || "Local Parakeet helper failed.",
        });
      },
    );
  });
};

const startService = async (engine: Engine): Promise<void> => {
  if (serviceReady) return serviceReady;
  const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
  if (!helperPath) {
    throw new Error("Local Parakeet helper has not been built.");
  }
  const args = await serveArgs(engine);

  serviceReady = new Promise((resolve, reject) => {
    let readySettled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    const resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      if (readyTimeout) clearTimeout(readyTimeout);
      resolve();
    };

    const rejectReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      if (readyTimeout) clearTimeout(readyTimeout);
      reject(error);
    };

    const child = spawn(helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    serviceProcess = child;

    readyTimeout = setTimeout(() => {
      rejectReady(new Error("Local Parakeet helper did not become ready."));
      stopService();
    }, SERVICE_READY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      serviceBuffer += chunk;
      let newlineIndex = serviceBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = serviceBuffer.slice(0, newlineIndex).trim();
        serviceBuffer = serviceBuffer.slice(newlineIndex + 1);
        handleServiceLine(line, resolveReady, rejectReady);
        newlineIndex = serviceBuffer.indexOf("\n");
      }
    });

    child.once("error", (error) => {
      rejectReady(error);
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
    });

    child.once("exit", (code, signal) => {
      const error = new Error(
        `Local Parakeet helper exited (${signal ?? code ?? "unknown"}).`,
      );
      rejectReady(error);
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
  readyReject: (error: Error) => void,
) => {
  const parsed = parseHelperResponse(line);
  if (!parsed) return;
  if (!parsed.id) {
    if (parsed.ok) {
      readyResolve();
    } else {
      readyReject(
        new Error(parsed.error ?? "Local Parakeet helper failed to start."),
      );
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
  clearIdleEviction();
  const child = serviceProcess;
  if (!child) return;
  failPending(new Error("Local Parakeet helper stopped."));
  try {
    child.stdin.end();
  } catch {
    // Ignore shutdown races.
  }
  try {
    child.kill();
  } catch {
    // Already stopped.
  }
  serviceProcess = null;
  serviceReady = null;
  serviceBuffer = "";
};

export const stopLocalParakeet = (): void => {
  stopService();
};

const transcribeWithService = async (
  engine: Engine,
  audioPath: string,
): Promise<HelperResponse> => {
  await startService(engine);
  const child = serviceProcess;
  if (!child || child.stdin.destroyed) {
    throw new Error("Local Parakeet helper is not running.");
  }
  // Perf: each transcription is "activity" — reset the idle-eviction countdown
  // so an actively-used model stays warm while an idle one gets evicted.
  armIdleEviction();
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
  const engine = resolveEngine();
  if (!engine) return status;

  // For the cpp engine, the model may still be downloading. Kick the download
  // in the background and start the serve loop once it lands, but don't block
  // the warm call (or report unavailable) just because the model isn't here
  // yet — local becomes ready transparently on a later dictation.
  if (engine === "cpp" && !cppModelIsReady()) {
    void ensureCppModel()
      .then(() => startService(engine))
      // Perf: a pure warm (no transcription) is still subject to idle eviction
      // so warming and walking away doesn't leave the model resident forever.
      .then(armIdleEviction)
      .catch(() => undefined);
    return { available: true, model: status.model };
  }

  try {
    await startService(engine);
    // Perf: arm idle eviction so a warmed-but-unused model gets reclaimed.
    armIdleEviction();
    return { available: true, model: status.model };
  } catch (error) {
    return {
      available: false,
      model: status.model,
      reason: (error as Error).message,
    };
  }
};

export const getLocalParakeetStatus =
  async (): Promise<LocalParakeetStatus> => {
    const engine = resolveEngine();
    if (!engine) {
      return {
        available: false,
        model: CPP_MODEL_ID,
        reason: "Local Parakeet dictation is not supported on this platform.",
      };
    }
    const modelId = MODEL_ID_BY_ENGINE[engine];
    const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
    if (!helperPath) {
      return {
        available: false,
        model: modelId,
        reason: "Local Parakeet helper has not been built.",
      };
    }
    const result = await runProbe(engine);
    return {
      available: result.ok,
      model: modelId,
      reason: result.ok ? undefined : result.error,
    };
  };

export const transcribeWithLocalParakeet = async (
  wavBase64: string,
): Promise<{ transcript: string; model: string }> => {
  const engine = resolveEngine();
  if (!engine) {
    throw new Error(
      "Local Parakeet dictation is not supported on this platform.",
    );
  }
  const status = await getLocalParakeetStatus();
  if (!status.available) {
    throw new Error(
      status.reason ?? "Local Parakeet dictation is unavailable.",
    );
  }

  const tempDir = path.join(os.tmpdir(), "stella-dictation");
  await mkdir(tempDir, { recursive: true });
  const audioPath = path.join(tempDir, `${randomUUID()}.wav`);
  try {
    await writeFile(audioPath, Buffer.from(wavBase64, "base64"));
    const result = await transcribeWithService(engine, audioPath);
    if (!result.ok) {
      throw new Error(result.error ?? "Local Parakeet transcription failed.");
    }
    return {
      transcript: result.transcript ?? "",
      model: result.model || status.model,
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => undefined);
  }
};
