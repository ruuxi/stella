import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMediaToolHandlers } from "../../../../../runtime/kernel/tools/media.js";
import {
  attachImageOperationJob,
  reserveDurableImageOperation,
} from "../../../../../runtime/kernel/tools/image-operation-store.js";
import { materializeMediaArtifact } from "../../../../../runtime/kernel/tools/media-artifact-store.js";
import { executeRuntimeToolCall } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
  vi.restoreAllMocks();
});

const contextFor = (stellaDataDir: string): ToolContext => ({
  conversationId: "conversation-image-terminal",
  deviceId: "device-image-terminal",
  requestId: "tool-call-image-1",
  runId: "run-image-terminal",
  rootRunId: "root-run-image-terminal",
  agentType: "orchestrator",
  stellaAppDir: stellaDataDir,
  stellaDataDir,
  storageMode: "local",
});

const accepted = (reattached = false) =>
  new Response(
    JSON.stringify({
      jobId: "job-image-1",
      capability: "text_to_image",
      profile: "best",
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      ...(reattached ? { reattached: true } : {}),
    }),
    { status: 202, headers: { "content-type": "application/json" } },
  );

const jobResponse = (
  status: "queued" | "running" | "succeeded" | "failed" | "canceled",
  extra: Record<string, unknown> = {},
) =>
  new Response(
    JSON.stringify({
      jobId: "job-image-1",
      capability: "text_to_image",
      profile: "best",
      request: { prompt: "draw a durable fox" },
      status,
      upstreamStatus: status.toUpperCase(),
      createdAt: 1,
      updatedAt: 2,
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const outputResponse = () =>
  new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

const createHandler = (
  fetchImpl: typeof fetch,
  tuning: Record<string, unknown> = {},
) =>
  createMediaToolHandlers({
    getStellaSiteAuth: () => ({
      baseUrl: "https://stella.test",
      authToken: "test-token",
    }),
    managedImageJob: { fetchImpl, ...tuning },
  }).image_gen!;

describe("image_gen terminal managed-media semantics", () => {
  it("routes a persisted BYOK image preference through the durable managed gateway", async () => {
    const stellaDataDir = tempDirs.create("image-gen-byok-routed-");
    await writeFile(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ imageGeneration: { provider: "openai", model: "gpt-image-1" } }),
    );
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/media/v1/generate")) return accepted();
      if (url.includes("/api/media/v1/job?")) {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/image.png" }] },
        });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const result = await createHandler(fetchImpl)(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
    );
    expect(result.error).toBeUndefined();
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(false);
    expect(urls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    expect(urls.some((url) => url.includes("queue.fal.run"))).toBe(false);
    expect(urls[0]).toBe("https://stella.test/api/media/v1/generate");
  });

  it("keeps the tool promise pending until delayed success and durable output", async () => {
    const stellaDataDir = tempDirs.create("image-gen-terminal-");
    let resolveJob!: (response: Response) => void;
    const delayedJob = new Promise<Response>((resolve) => {
      resolveJob = resolve;
    });
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate") && init?.method === "POST")
        return accepted();
      if (url.includes("/job?") && init?.method === "GET") return delayedJob;
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;
    const handler = createHandler(fetchImpl);
    let settled = false;
    const pending = handler(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    expect(settled).toBe(false);
    resolveJob(
      jobResponse("succeeded", {
        completedAt: 3,
        output: { images: [{ url: "https://assets.test/image.png" }] },
      }),
    );

    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      capability: "text_to_image",
      filePaths: [expect.stringContaining("job-image-1_0.png")],
      artifacts: [
        expect.objectContaining({ kind: "image", index: 0, sizeBytes: 7 }),
      ],
    });
    const details = result.details as { filePaths: string[] };
    expect((await stat(details.filePaths[0]!)).size).toBe(7);
  });

  it("returns delayed gateway failure as a structured terminal error", async () => {
    const stellaDataDir = tempDirs.create("image-gen-failure-");
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) return accepted();
      if (url.includes("/job?") && init?.method === "GET") {
        polls += 1;
        return polls === 1
          ? jobResponse("running")
          : jobResponse("failed", {
              error: { code: "POLICY", message: "Image request was blocked." },
            });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const onUpdate = vi.fn();
    const result = await createHandler(fetchImpl, {
      sleep: async () => undefined,
    })(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
      { onUpdate },
    );

    expect(result.error).toBe("Image request was blocked.");
    expect(onUpdate).toHaveBeenCalledWith({
      details: expect.objectContaining({
        jobId: "job-image-1",
        status: "running",
        statusText: "Generating image…",
      }),
    });
    expect(result.details).toEqual({
      jobId: "job-image-1",
      status: "failed",
      error: { code: "policy", message: "Image request was blocked." },
      reattached: false,
    });
  });

  it("cancels durably on abort and leaves no polling timer alive", async () => {
    const stellaDataDir = tempDirs.create("image-gen-abort-");
    const controller = new AbortController();
    let deleteCalls = 0;
    let pollAborted = false;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/generate")) return accepted();
        if (url.includes("/job?") && init?.method === "GET") {
          return await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => {
                pollAborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        if (url.endsWith("/job") && init?.method === "DELETE") {
          deleteCalls += 1;
          return new Response("{}", { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    ) as unknown as typeof fetch;
    const pending = createHandler(fetchImpl)(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException("User canceled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pollAborted).toBe(true);
    expect(deleteCalls).toBe(1);
  });

  it("reattaches duplicate completion with the same durable identity and reuses one local artifact", async () => {
    const stellaDataDir = tempDirs.create("image-gen-reattach-");
    const idempotencyKeys: string[] = [];
    let posts = 0;
    let downloads = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) {
        posts += 1;
        idempotencyKeys.push(
          new Headers(init?.headers).get("idempotency-key")!,
        );
        return accepted(posts > 1);
      }
      if (url.includes("/job?") && init?.method === "GET") {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/image.png" }] },
        });
      }
      if (url === "https://assets.test/image.png") {
        downloads += 1;
        return outputResponse();
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const handler = createHandler(fetchImpl);
    const first = await handler(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
    );
    const replay = await handler(
      { prompt: "draw a durable fox" },
      {
        ...contextFor(stellaDataDir),
        runId: "run-after-runtime-restart",
        rootRunId: "root-after-runtime-restart",
      },
    );

    expect(posts).toBe(1);
    expect(idempotencyKeys).toHaveLength(1);
    expect(downloads).toBe(1);
    expect(replay.result).toMatchObject({
      jobId: "job-image-1",
      reattached: true,
      filePaths: (first.result as { filePaths: string[] }).filePaths,
    });
  });

  it("reattaches after a lost submission response without changing identity", async () => {
    const stellaDataDir = tempDirs.create("image-gen-relay-reconnect-");
    const idempotencyKeys: string[] = [];
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) {
        posts += 1;
        idempotencyKeys.push(
          new Headers(init?.headers).get("idempotency-key")!,
        );
        if (posts === 1) {
          throw new Error("relay disconnected after request send");
        }
        return accepted(true);
      }
      if (url.includes("/job?") && init?.method === "GET") {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/image.png" }] },
        });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const result = await createHandler(fetchImpl, {
      sleep: async () => undefined,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));

    expect(result.error).toBeUndefined();
    expect(posts).toBe(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(result.result).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      reattached: true,
    });
  });

  it("reattaches a persisted pending job after runtime-worker restart", async () => {
    const stellaDataDir = tempDirs.create("image-gen-runtime-restart-");
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate") && init?.method === "POST") {
        return accepted(true);
      }
      if (url.includes("/job?") && init?.method === "GET") {
        polls += 1;
        return polls === 1
          ? jobResponse("running")
          : jobResponse("succeeded", {
              output: { images: [{ url: "https://assets.test/image.png" }] },
            });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const result = await createHandler(fetchImpl, {
      sleep: async () => undefined,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));

    expect(polls).toBe(2);
    expect(result.result).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      reattached: true,
      filePaths: [expect.stringContaining("job-image-1_0.png")],
    });
  });

  it("reattaches an actual persisted operation with a fresh native/Codex call id", async () => {
    const stellaDataDir = tempDirs.create("image-gen-persisted-operation-");
    const requestBody = {
      capability: "text_to_image",
      prompt: "draw a durable fox",
    };
    const reserved = reserveDurableImageOperation({
      stellaDataDir,
      conversationId: contextFor(stellaDataDir).conversationId,
      toolCallId: "old-process-call-id",
      requestBody,
    });
    attachImageOperationJob({
      stellaDataDir,
      operationId: reserved.operationId,
      jobId: "job-image-1",
    });
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) {
        posts += 1;
        return accepted(true);
      }
      if (url.includes("/job?") && init?.method === "GET") {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/image.png" }] },
        });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const result = await createHandler(fetchImpl)(
      { prompt: "draw a durable fox" },
      { ...contextFor(stellaDataDir), requestId: "new-process-call-id" },
    );
    expect(posts).toBe(0);
    expect(result.result).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      reattached: true,
    });
  });

  it("delivers a cached terminal result through the production adapter after external restart", async () => {
    const stellaDataDir = tempDirs.create("image-gen-adapter-restart-");
    let networkCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      networkCalls += 1;
      const url = String(input);
      if (url.endsWith("/generate")) return accepted();
      if (url.includes("/job?")) {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/image.png" }] },
        });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const handler = createHandler(fetchImpl);
    const toolExecutor = async (
      _name: string,
      args: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
    ) => await handler(args, context, signal ? { signal } : undefined);
    const base = {
      toolName: "image_gen",
      args: { prompt: "draw a durable fox" },
      conversationId: "adapter-restart-conversation",
      agentType: "orchestrator",
      deviceId: "adapter-device",
      stellaAppDir: stellaDataDir,
      stellaDataDir,
      deferImageDeliveryAck: true,
      store: {} as never,
      toolExecutor,
    };
    const first = await executeRuntimeToolCall({
      ...base,
      toolCallId: "codex-process-one-call",
      runId: "codex-process-one-run",
    });
    const callsAfterFirst = networkCalls;
    const recovered = await executeRuntimeToolCall({
      ...base,
      toolCallId: "codex-process-two-call",
      runId: "codex-process-two-run",
    });
    expect(networkCalls).toBe(callsAfterFirst);
    expect(recovered.result).toMatchObject({
      jobId: (first.result as { jobId: string }).jobId,
      filePaths: (first.result as { filePaths: string[] }).filePaths,
    });
    expect(recovered.details).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      reattached: true,
    });
  });

  it("waits through succeeded-before-output handoff", async () => {
    const stellaDataDir = tempDirs.create("image-gen-handoff-");
    let now = 0;
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/generate")) return accepted();
      if (url.includes("/job?")) {
        polls += 1;
        return polls === 1
          ? jobResponse("succeeded")
          : jobResponse("succeeded", {
              output: { images: [{ url: "https://assets.test/image.png" }] },
            });
      }
      if (url === "https://assets.test/image.png") return outputResponse();
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const result = await createHandler(fetchImpl, {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      timeoutMs: 5_000,
      initialPollMs: 100,
      maxPollMs: 100,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));
    expect(result.error).toBeUndefined();
    expect(polls).toBe(2);
  });

  it("enforces bounded timeout and cancels the durable request", async () => {
    const stellaDataDir = tempDirs.create("image-gen-timeout-");
    let now = 0;
    let deleteCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) return accepted();
      if (url.includes("/job?") && init?.method === "GET") {
        return jobResponse("queued");
      }
      if (url.endsWith("/job") && init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const result = await createHandler(fetchImpl, {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      timeoutMs: 1_000,
      initialPollMs: 400,
      maxPollMs: 400,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));

    expect(result.error).toBe("Image generation timed out after 1 minute.");
    expect(result.details).toMatchObject({
      jobId: "job-image-1",
      status: "failed",
      error: { code: "timeout" },
    });
    expect(deleteCalls).toBe(1);
  });

  it("bounds each artifact download inside the grace window and cleans temp state", async () => {
    const stellaDataDir = tempDirs.create("image-gen-download-timeout-");
    let now = 0;
    let downloadAborts = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/generate")) return accepted();
      if (url.includes("/job?")) {
        return jobResponse("succeeded", {
          output: { images: [{ url: "https://assets.test/hangs.png" }] },
        });
      }
      if (url === "https://assets.test/hangs.png") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            downloadAborts += 1;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const result = await createHandler(fetchImpl, {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      timeoutMs: 1_000,
      artifactGraceMs: 40,
      artifactDownloadTimeoutMs: 10,
      initialPollMs: 20,
      maxPollMs: 20,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));
    expect(result.details).toMatchObject({
      status: "failed",
      error: { code: "artifact_materialization_failed" },
    });
    expect(downloadAborts).toBeGreaterThan(0);
    const files = await readdir(path.join(stellaDataDir, "media", "outputs"));
    expect(files.filter((name) => name.includes(".partial-") || name.endsWith(".lock"))).toEqual([]);
  });

  it("serializes concurrent terminal and renderer writers to one complete payload", async () => {
    const stellaDataDir = tempDirs.create("image-gen-concurrent-writers-");
    const filePath = path.join(stellaDataDir, "media", "outputs", "job-race_0.png");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(filePath), { recursive: true }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let producers = 0;
    const first = materializeMediaArtifact({
      filePath,
      producer: async () => {
        producers += 1;
        announceStarted();
        await gate;
        return Buffer.from("complete-terminal-payload");
      },
    });
    await started;
    const second = materializeMediaArtifact({
      filePath,
      producer: async () => {
        producers += 1;
        return Buffer.from("renderer-duplicate");
      },
    });
    expect(producers).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(producers).toBe(1);
    expect(left.path).toBe(right.path);
    expect(await readFile(filePath, "utf8")).toBe("complete-terminal-payload");
  });
});
