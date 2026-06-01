#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { resolveStatePath } from "./shared.js";

type MediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

type MediaJobError = {
  message?: string;
  code?: string;
};

type MediaJob = {
  jobId: string;
  capability?: string;
  profile?: string;
  request?: {
    prompt?: string;
  };
  status: MediaJobStatus;
  upstreamStatus?: string;
  output?: unknown;
  error?: MediaJobError;
  completedAt?: number;
  updatedAt?: number;
};

type AcceptedMediaJob = {
  jobId: string;
  capability?: string;
  profile?: string;
  status?: MediaJobStatus;
  upstreamStatus?: string;
};

type OutputFile = {
  kind: "image" | "video" | "audio" | "download";
  url: string;
  path: string;
};

type CliOptions = {
  command: string;
  request?: string;
  requestFile?: string;
  jobId?: string;
  wait: boolean;
  save: boolean;
  json: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
};

const usage = `stella-media - submit and watch Stella managed media jobs

Usage:
  stella-media capabilities [--json]
  stella-media generate --request '<json>' [--wait] [--timeout 240] [--json]
  stella-media generate --request-file request.json [--wait] [--timeout 240] [--json]
  stella-media status --job-id <jobId> [--save] [--json]

Environment:
  STELLA_MEDIA_BASE_URL       Stella site base URL
  STELLA_MEDIA_AUTH_TOKEN     Stella bearer token
`;

const terminalStatuses = new Set<MediaJobStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

const parseDurationSeconds = (
  value: string | undefined,
  fallbackMs: number,
): number => {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed * 1000);
};

const parseArgs = (argv: string[]): CliOptions => {
  const [command = "help", ...rest] = argv;
  const options: CliOptions = {
    command: command === "-h" || command === "--help" ? "help" : command,
    wait: false,
    save: false,
    json: false,
    timeoutMs: 240_000,
    pollIntervalMs: 2_000,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--request":
        options.request = rest[++i];
        break;
      case "--request-file":
        options.requestFile = rest[++i];
        break;
      case "--job-id":
        options.jobId = rest[++i];
        break;
      case "--wait":
        options.wait = true;
        break;
      case "--save":
        options.save = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--timeout":
        options.timeoutMs = parseDurationSeconds(rest[++i], options.timeoutMs);
        break;
      case "--poll-interval":
        options.pollIntervalMs = parseDurationSeconds(
          rest[++i],
          options.pollIntervalMs,
        );
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const getAuth = (): {
  baseUrl: string;
  authToken: string;
  deviceId?: string;
} => {
  const baseUrl =
    process.env.STELLA_MEDIA_BASE_URL?.trim() ||
    process.env.STELLA_SITE_URL?.trim() ||
    process.env.STELLA_LLM_PROXY_URL?.trim() ||
    "";
  const authToken =
    process.env.STELLA_MEDIA_AUTH_TOKEN?.trim() ||
    process.env.STELLA_AUTH_TOKEN?.trim() ||
    process.env.STELLA_LLM_PROXY_TOKEN?.trim() ||
    "";
  if (!baseUrl || !authToken) {
    throw new Error(
      "stella-media requires Stella sign-in. Open Stella and finish signing in, then retry.",
    );
  }
  const deviceId = process.env.STELLA_DEVICE_ID?.trim() || undefined;
  return { baseUrl, authToken, ...(deviceId ? { deviceId } : {}) };
};

const mediaUrl = (baseUrl: string, pathname: string): string =>
  new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const requestHeaders = (auth: {
  authToken: string;
  deviceId?: string;
}): Record<string, string> => ({
  Authorization: `Bearer ${auth.authToken}`,
  ...(auth.deviceId ? { "X-Device-ID": auth.deviceId } : {}),
});

const fetchJson = async <T>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = "";
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      message = body.error ?? body.message ?? "";
    } catch {
      message = await response.text().catch(() => "");
    }
    throw new Error(
      message || `Stella media request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as T;
};

const readRequestBody = async (options: CliOptions): Promise<unknown> => {
  if (options.request) return JSON.parse(options.request) as unknown;
  if (options.requestFile) {
    const raw = await readFile(path.resolve(options.requestFile), "utf-8");
    return JSON.parse(raw) as unknown;
  }
  throw new Error("generate requires --request or --request-file.");
};

const submitJob = async (body: unknown): Promise<AcceptedMediaJob> => {
  const auth = getAuth();
  return await fetchJson<AcceptedMediaJob>(
    mediaUrl(auth.baseUrl, "/api/media/v1/generate"),
    {
      method: "POST",
      headers: {
        ...requestHeaders(auth),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
};

const getJob = async (jobId: string): Promise<MediaJob> => {
  const auth = getAuth();
  const url = new URL(mediaUrl(auth.baseUrl, "/api/media/v1/job"));
  url.searchParams.set("jobId", jobId);
  return await fetchJson<MediaJob>(url.toString(), {
    method: "GET",
    headers: requestHeaders(auth),
  });
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const waitForJob = async (
  jobId: string,
  options: Pick<CliOptions, "timeoutMs" | "pollIntervalMs" | "json">,
): Promise<MediaJob> => {
  const deadline = Date.now() + options.timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (job.status !== lastStatus && !options.json) {
      process.stderr.write(`media job ${jobId}: ${job.status}\n`);
      lastStatus = job.status;
    }
    if (terminalStatuses.has(job.status)) {
      return job;
    }
    await sleep(
      Math.min(options.pollIntervalMs, Math.max(250, deadline - Date.now())),
    );
  }
  throw new Error("Image generation took too long");
};

const friendlyMediaFailure = (error: MediaJobError | undefined): string => {
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  switch (code) {
    case "request_timeout":
    case "timeout":
      return "Image generation took too long";
    case "startup_timeout":
      return "Image generation took too long to start";
    case "runner_scheduling_failure":
    case "runner_connection_timeout":
    case "runner_disconnected":
    case "runner_connection_refused":
    case "runner_connection_error":
      return "Image service is busy";
    case "runner_incomplete_response":
    case "payload_error":
      return "Image result could not be read";
    case "runner_server_error":
    case "internal_error":
      return "Image service hit a temporary error";
    case "bad_request":
      return "Image request was invalid";
  }

  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/\b(policy|safety|moderation|blocked|nsfw)\b/i.test(message)) {
    return "Image request was blocked";
  }
  if (/\b(rate|429|concurrency|busy|capacity)\b/i.test(message)) {
    return "Image service is busy";
  }
  if (/\b(auth|api key|unauthorized|forbidden|401|403)\b/i.test(message)) {
    return "Image service is not configured";
  }
  if (/\b(required|invalid|validation|422|bad request)\b/i.test(message)) {
    return "Image request was invalid";
  }
  if (/\b(timeout|timed out|deadline)\b/i.test(message)) {
    return "Image generation took too long";
  }
  return "Image generation failed";
};

const extensionFromUrl = (
  url: string,
  fallback: string,
  contentType?: string | null,
): string => {
  const fromUrl = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("mp4")) return "mp4";
  if (contentType?.includes("mpeg")) return "mp3";
  if (contentType?.includes("wav")) return "wav";
  return fallback;
};

const outputUrls = (
  output: unknown,
): Array<{
  kind: OutputFile["kind"];
  url: string;
  fallbackExt: string;
}> => {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  if (Array.isArray(record.images)) {
    return record.images
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { url?: unknown }).url
          : undefined,
      )
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => ({ kind: "image", url, fallbackExt: "png" }));
  }
  const video = record.video;
  if (video && typeof video === "object") {
    const url = (video as { url?: unknown }).url;
    if (typeof url === "string")
      return [{ kind: "video", url, fallbackExt: "mp4" }];
  }
  for (const key of ["audio_file", "audio"]) {
    const audio = record[key];
    if (audio && typeof audio === "object") {
      const url = (audio as { url?: unknown }).url;
      if (typeof url === "string")
        return [{ kind: "audio", url, fallbackExt: "mp3" }];
    }
  }
  const model = record.model_mesh;
  if (model && typeof model === "object") {
    const url = (model as { url?: unknown }).url;
    if (typeof url === "string") {
      return [{ kind: "download", url, fallbackExt: "glb" }];
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const url = (value as { url?: unknown }).url;
      if (typeof url === "string") {
        return [{ kind: "download", url, fallbackExt: "bin" }];
      }
    }
  }
  return [];
};

const saveOutputs = async (job: MediaJob): Promise<OutputFile[]> => {
  const urls = outputUrls(job.output);
  if (urls.length === 0) return [];
  const outputDir = path.join(resolveStatePath(), "media", "outputs");
  await mkdir(outputDir, { recursive: true });

  const files: OutputFile[] = [];
  for (const [index, item] of urls.entries()) {
    const response = await fetch(item.url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download media output (${response.status}).`);
    }
    const ext = extensionFromUrl(
      item.url,
      item.fallbackExt,
      response.headers.get("content-type"),
    );
    const suffix = item.kind === "image" || urls.length > 1 ? `_${index}` : "";
    const filePath = path.join(outputDir, `${job.jobId}${suffix}.${ext}`);
    await pipeline(response.body, createWriteStream(filePath));
    files.push({ kind: item.kind, url: item.url, path: filePath });
  }
  return files;
};

const print = (value: unknown, json: boolean): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
};

const handleTerminalJob = async (
  job: MediaJob,
  options: Pick<CliOptions, "json" | "save">,
): Promise<number> => {
  if (job.status === "succeeded") {
    const files = options.save ? await saveOutputs(job) : [];
    if (options.json) {
      print({ job, files }, true);
    } else {
      print(`Media job ${job.jobId} completed.`, false);
      for (const file of files) {
        print(`${file.kind}: ${file.path}`, false);
      }
    }
    return 0;
  }

  const message = friendlyMediaFailure(job.error);
  if (options.json) {
    print({ job, error: message }, true);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return 1;
};

const run = async (): Promise<number> => {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    print(usage, false);
    return 0;
  }

  if (options.command === "capabilities") {
    const auth = getAuth();
    const result = await fetchJson<unknown>(
      mediaUrl(auth.baseUrl, "/api/media/v1/capabilities"),
      { method: "GET", headers: requestHeaders(auth) },
    );
    print(result, options.json);
    return 0;
  }

  if (options.command === "generate") {
    const body = await readRequestBody(options);
    const accepted = await submitJob(body);
    if (!options.wait) {
      print(accepted, options.json);
      return 0;
    }
    if (!accepted.jobId) {
      throw new Error("Media gateway did not return a jobId.");
    }
    if (!options.json) {
      process.stderr.write(`media job ${accepted.jobId}: submitted\n`);
    }
    const job = await waitForJob(accepted.jobId, options);
    return await handleTerminalJob(job, { ...options, save: true });
  }

  if (options.command === "status") {
    if (!options.jobId) throw new Error("status requires --job-id.");
    const job = await getJob(options.jobId);
    if (!terminalStatuses.has(job.status)) {
      print(job, options.json);
      return 0;
    }
    return await handleTerminalJob(job, options);
  }

  throw new Error(`Unknown command: ${options.command}`);
};

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = /took too long/i.test(message) ? 124 : 1;
  });
