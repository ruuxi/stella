import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMediaToolHandlers } from "../../../../../runtime/kernel/tools/media.js";
import {
  attachImageOperationJob,
  markImageOperationDelivered,
  pruneImageOperationLedger,
  reserveDurableImageOperation,
  settleImageOperation,
} from "../../../../../runtime/kernel/tools/image-operation-store.js";
import { materializeMediaArtifact } from "../../../../../runtime/kernel/tools/media-artifact-store.js";
import {
  decodeAndValidateImage,
  validateDecodedImageFile,
} from "../../../../../runtime/kernel/tools/image-decode-validation.js";
import { readAuthorizedImageReference } from "../../../../../runtime/kernel/tools/image-reference-policy.js";
import { localImagePollSleep } from "../../../../../runtime/kernel/tools/local-image-generation.js";
import { executeRuntimeToolCall } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import { saveLocalLlmCredential } from "../../../../../runtime/kernel/storage/llm-credentials.js";
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
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled"
    | "unknown",
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
  new Response(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    {
      status: 200,
      headers: { "content-type": "image/png" },
    },
  );

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
  it("removes the Fal polling abort listener after 1,200 normal sleeps", async () => {
    vi.useFakeTimers();
    try {
      const signal = new AbortController().signal;
      const add = vi.spyOn(signal, "addEventListener");
      const remove = vi.spyOn(signal, "removeEventListener");
      for (let index = 0; index < 1_200; index += 1) {
        const pending = localImagePollSleep(1, signal);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
      }
      expect(add).toHaveBeenCalledTimes(1_200);
      expect(remove).toHaveBeenCalledTimes(1_200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a persisted BYOK preference without touching the managed gateway", async () => {
    const stellaDataDir = tempDirs.create("image-gen-byok-routed-");
    await writeFile(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({
        imageGeneration: { provider: "openai", model: "gpt-image-1" },
      }),
    );
    saveLocalLlmCredential(stellaDataDir, {
      provider: "openai",
      label: "OpenAI",
      plaintext: "test-openai-key",
    });
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v1/images/generations")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                b64_json:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const managedFetch = vi.fn() as unknown as typeof fetch;
    const result = await createHandler(managedFetch)(
      { prompt: "draw a durable fox" },
      contextFor(stellaDataDir),
    );
    expect(result.error).toBeUndefined();
    expect(urls).toEqual(["https://api.openai.com/v1/images/generations"]);
    expect(managedFetch).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      provider: "openai",
      status: "succeeded",
    });
  });

  it("rejects unsupported direct OpenAI remote edits before consuming a submission claim", async () => {
    const stellaDataDir = tempDirs.create("image-gen-openai-remote-reference-");
    await writeFile(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ imageGeneration: { provider: "openai" } }),
    );
    saveLocalLlmCredential(stellaDataDir, {
      provider: "openai",
      label: "OpenAI",
      plaintext: "test-openai-key",
    });
    const directFetch = vi.spyOn(globalThis, "fetch");
    const managedFetch = vi.fn() as unknown as typeof fetch;
    const result = await createHandler(managedFetch)(
      {
        prompt: "edit a remote reference",
        referenceImageUrls: ["https://example.test/private.png"],
      },
      contextFor(stellaDataDir),
    );
    expect(result.details).toMatchObject({
      status: "failed",
      error: { code: "unsupported_reference" },
    });
    expect(directFetch).not.toHaveBeenCalled();
    expect(managedFetch).not.toHaveBeenCalled();
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
        expect.objectContaining({
          kind: "image",
          index: 0,
          sizeBytes: expect.any(Number),
        }),
      ],
    });
    const details = result.details as { filePaths: string[] };
    expect((await stat(details.filePaths[0]!)).size).toBeGreaterThan(8);
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
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir), {
      onUpdate,
    });

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
    expect(posts).toBe(1);
    expect(idempotencyKeys).toHaveLength(1);
    expect(result.result).toMatchObject({
      jobId: "job-image-1",
      status: "succeeded",
      reattached: true,
    });
  });

  it("reconciles after all three POST responses are lost and the process restarts", async () => {
    const stellaDataDir = tempDirs.create("image-gen-all-post-responses-lost-");
    let posts = 0;
    let sleeps = 0;
    const disconnectedFetch = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        if (String(input).endsWith("/generate") && init?.method === "POST") {
          posts += 1;
          throw new Error("relay lost accepted POST response");
        }
        if (String(input).includes("/job?") && init?.method === "GET") {
          throw new Error("relay lookup unavailable");
        }
        throw new Error(`Unexpected fetch ${String(input)}`);
      },
    ) as unknown as typeof fetch;
    await expect(
      createHandler(disconnectedFetch, {
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 3) throw new Error("simulated process exit");
        },
      })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir)),
    ).rejects.toThrow("simulated process exit");
    expect(posts).toBe(3);

    const recoveredFetch = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/generate") && init?.method === "POST") {
          posts += 1;
          throw new Error("must reconcile before another POST");
        }
        if (url.includes("/job?") && init?.method === "GET") {
          if (url.includes("clientRequestKey=")) return accepted(true);
          return jobResponse("succeeded", {
            output: { images: [{ url: "https://assets.test/image.png" }] },
          });
        }
        if (url === "https://assets.test/image.png") return outputResponse();
        throw new Error(`Unexpected fetch ${url}`);
      },
    ) as unknown as typeof fetch;
    const recovered = await createHandler(recoveredFetch, {
      sleep: async () => undefined,
    })({ prompt: "draw a durable fox" }, contextFor(stellaDataDir));
    expect(posts).toBe(3);
    expect(recovered.result).toMatchObject({
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

  it("reattaches a pre-canonical persisted operation once during alias migration", async () => {
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
    const legacyDb = new DatabaseSync(
      path.join(stellaDataDir, "image-tool-operations.sqlite"),
    );
    legacyDb.exec(
      "UPDATE image_tool_operation_aliases SET identity_version = 1",
    );
    legacyDb.close();
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
      toolCallId: "codex-stable-call",
      runId: "codex-process-one-run",
    });
    const callsAfterFirst = networkCalls;
    const recovered = await executeRuntimeToolCall({
      ...base,
      toolCallId: "codex-stable-call",
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

  it("returns a distinct unknown timeout without canceling accepted work", async () => {
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

    expect(result.error).toContain("no durable terminal outcome");
    expect(result.details).toMatchObject({
      jobId: "job-image-1",
      status: "unknown",
      error: { code: "terminal_outcome_unknown" },
    });
    expect(deleteCalls).toBe(0);
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
          init?.signal?.addEventListener(
            "abort",
            () => {
              downloadAborts += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const result = await createHandler(fetchImpl, {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
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
    expect(
      files.filter(
        (name) => name.includes(".partial-") || name.endsWith(".lock"),
      ),
    ).toEqual([]);
  });

  it("serializes concurrent terminal and renderer writers to one complete payload", async () => {
    const stellaDataDir = tempDirs.create("image-gen-concurrent-writers-");
    const filePath = path.join(
      stellaDataDir,
      "media",
      "outputs",
      "job-race_0.png",
    );
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(filePath), { recursive: true }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
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

  it("serializes real multi-process artifact writers and publishes one payload", async () => {
    const stellaDataDir = tempDirs.create("image-gen-multiprocess-writers-");
    const filePath = path.join(
      stellaDataDir,
      "media",
      "outputs",
      "job-process_0.png",
    );
    const markerPath = path.join(stellaDataDir, "producers.log");
    const modulePath = path.resolve(
      process.cwd(),
      "../runtime/kernel/tools/media-artifact-store.ts",
    );
    const validatorModulePath = path.resolve(
      process.cwd(),
      "../runtime/kernel/tools/image-decode-validation.ts",
    );
    const payload = outputResponse();
    const payloadBase64 = Buffer.from(await payload.arrayBuffer()).toString(
      "base64",
    );
    const source = `
      import { appendFileSync } from "node:fs";
      import { materializeMediaArtifact } from ${JSON.stringify(modulePath)};
      import { validateDecodedImageFile } from ${JSON.stringify(validatorModulePath)};
      await materializeMediaArtifact({
        filePath: ${JSON.stringify(filePath)},
        validateExisting: validateDecodedImageFile,
        producer: async () => {
          appendFileSync(${JSON.stringify(markerPath)}, String(process.pid) + "\\n");
          await new Promise((resolve) => setTimeout(resolve, 150));
          return Buffer.from(${JSON.stringify(payloadBase64)}, "base64");
        },
      });
    `;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("bun", ["--eval", source], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(stderr || `bun exited ${code}`)),
        );
      });
    await Promise.all([run(), run()]);
    expect(
      (await readFile(markerPath, "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    expect((await readFile(filePath)).toString("base64")).toBe(payloadBase64);
  });

  it("cleans stale partial artifacts before an atomic directory-synced publish", async () => {
    const stellaDataDir = tempDirs.create("image-gen-stale-partial-");
    const outputDir = path.join(stellaDataDir, "media", "outputs");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(outputDir, { recursive: true }),
    );
    const filePath = path.join(outputDir, "job-stale_0.png");
    const stalePartial = `${filePath}.partial-old-process`;
    await writeFile(stalePartial, "partial");
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(stalePartial, old, old);
    await materializeMediaArtifact({
      filePath,
      producer: async () => Buffer.from("complete"),
    });
    expect(await readFile(filePath, "utf8")).toBe("complete");
    await expect(stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects header-only and truncated image structures before atomic publish", async () => {
    const invalidImages = [
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("ffd8ffe000104a4649460001", "hex"),
      Buffer.from("47494638396101000100", "hex"),
      Buffer.from("524946461000000057454250", "hex"),
    ];
    for (const bytes of invalidImages) {
      expect(await decodeAndValidateImage(bytes)).toBeNull();
    }
    const root = tempDirs.create("image-gen-invalid-publish-");
    const filePath = path.join(root, "artifact.png");
    await expect(
      materializeMediaArtifact({
        filePath,
        validateExisting: validateDecodedImageFile,
        producer: async () => invalidImages[0]!,
      }),
    ).rejects.toThrow("full image validation");
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replay a delivered MCP alias for a different prompt", () => {
    const stellaDataDir = tempDirs.create("image-gen-alias-collision-");
    const common = {
      stellaDataDir,
      conversationId: "mcp-scope",
      toolCallId: "mcp:scope:1",
    };
    const first = reserveDurableImageOperation({
      ...common,
      requestBody: { prompt: "first image" },
    });
    settleImageOperation({
      stellaDataDir,
      operationId: first.operationId,
      result: {
        ok: false,
        status: "failed",
        code: "first_failure",
        message: "first terminal",
        reattached: false,
      },
    });
    markImageOperationDelivered({
      stellaDataDir,
      conversationId: common.conversationId,
      toolCallId: common.toolCallId,
    });
    const deliveredReplay = reserveDurableImageOperation({
      ...common,
      requestBody: { prompt: "first image" },
    });
    expect(deliveredReplay.operationId).toBe(first.operationId);
    expect(deliveredReplay.terminalResult).toMatchObject({
      ok: false,
      code: "first_failure",
      reattached: true,
    });
    const second = reserveDurableImageOperation({
      ...common,
      requestBody: { prompt: "different intentional image" },
    });
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.terminalResult).toBeUndefined();

    const sameRequestRestart = reserveDurableImageOperation({
      ...common,
      requestBody: { prompt: "different intentional image" },
    });
    expect(sameRequestRestart.operationId).toBe(second.operationId);
    expect(sameRequestRestart.reattached).toBe(true);

    const samePromptNewAlias = reserveDurableImageOperation({
      ...common,
      toolCallId: "mcp:scope:2",
      requestBody: { prompt: "different intentional image" },
    });
    expect(samePromptNewAlias.operationId).not.toBe(second.operationId);
    expect(samePromptNewAlias.reattached).toBe(false);
  });

  it("serializes legacy SQLite column migration across desktop processes", async () => {
    const stellaDataDir = tempDirs.create("image-gen-concurrent-migration-");
    const databasePath = path.join(
      stellaDataDir,
      "image-tool-operations.sqlite",
    );
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE image_tool_operations (
        operation_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        job_id TEXT,
        state TEXT NOT NULL,
        terminal_result_json TEXT,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE image_tool_operation_aliases (
        conversation_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, tool_call_id)
      );
    `);
    legacy.close();
    const modulePath = path.resolve(
      process.cwd(),
      "../runtime/kernel/tools/image-operation-store.ts",
    );
    const run = (toolCallId: string) =>
      new Promise<void>((resolve, reject) => {
        const source = `
          import { reserveDurableImageOperation } from ${JSON.stringify(modulePath)};
          reserveDurableImageOperation({
            stellaDataDir: ${JSON.stringify(stellaDataDir)},
            conversationId: "migration-conversation",
            toolCallId: ${JSON.stringify(toolCallId)},
            requestBody: { prompt: ${JSON.stringify(toolCallId)} },
          });
        `;
        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            source,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(stderr || `node exited ${code}`)),
        );
      });
    await Promise.all([run("migration-a"), run("migration-b")]);
    const migrated = new DatabaseSync(databasePath);
    const operationColumns = migrated
      .prepare("PRAGMA table_info(image_tool_operations)")
      .all() as Array<{ name: string }>;
    const aliasColumns = migrated
      .prepare("PRAGMA table_info(image_tool_operation_aliases)")
      .all() as Array<{ name: string }>;
    expect(operationColumns.map(({ name }) => name)).toContain(
      "submission_state",
    );
    expect(aliasColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["request_hash", "identity_version"]),
    );
    expect(
      (
        migrated
          .prepare("SELECT COUNT(*) AS count FROM image_tool_operations")
          .get() as { count: number }
      ).count,
    ).toBe(2);
    migrated.close();
  });

  it("prunes only delivered terminal operations and preserves pending reattachment", () => {
    const stellaDataDir = tempDirs.create("image-gen-ledger-prune-");
    const terminal = reserveDurableImageOperation({
      stellaDataDir,
      conversationId: "prune-conversation",
      toolCallId: "terminal-call",
      requestBody: { prompt: "terminal" },
    });
    settleImageOperation({
      stellaDataDir,
      operationId: terminal.operationId,
      result: {
        ok: false,
        status: "failed",
        code: "done",
        message: "done",
        reattached: false,
      },
    });
    markImageOperationDelivered({
      stellaDataDir,
      conversationId: "prune-conversation",
      toolCallId: "terminal-call",
    });
    const pending = reserveDurableImageOperation({
      stellaDataDir,
      conversationId: "prune-conversation",
      toolCallId: "pending-call",
      requestBody: { prompt: "pending" },
    });
    expect(
      pruneImageOperationLedger({
        stellaDataDir,
        deliveredBefore: Date.now() + 1,
      }),
    ).toBe(1);
    expect(
      reserveDurableImageOperation({
        stellaDataDir,
        conversationId: "prune-conversation",
        toolCallId: "pending-call",
        requestBody: { prompt: "pending" },
      }).operationId,
    ).toBe(pending.operationId);
  });

  it.each([
    ["openai", "gpt-image-2", "https://api.openai.com/v1/images/generations"],
    ["openrouter", "openai/gpt-image-2", "https://openrouter.ai/api/v1/images"],
    ["fal", "fal-ai/flux-2-pro", "https://queue.fal.run/fal-ai/flux-2-pro"],
  ])(
    "never blind-resubmits an ambiguous direct %s request after restart",
    async (provider, model, expectedUrl) => {
      const stellaDataDir = tempDirs.create(`image-gen-${provider}-ambiguous-`);
      await writeFile(
        path.join(stellaDataDir, "preferences.json"),
        JSON.stringify({ imageGeneration: { provider, model } }),
      );
      saveLocalLlmCredential(stellaDataDir, {
        provider,
        label: provider,
        plaintext: `test-${provider}-key`,
      });
      const directFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("connection lost after request send"));
      const managedFetch = vi.fn() as unknown as typeof fetch;
      const handler = createHandler(managedFetch);
      const first = await handler(
        { prompt: "ambiguous durable image" },
        contextFor(stellaDataDir),
      );
      const restarted = await handler(
        { prompt: "ambiguous durable image" },
        {
          ...contextFor(stellaDataDir),
          runId: "restart-run",
          rootRunId: "restart-root",
        },
      );
      expect(first.details).toMatchObject({
        status: "unknown",
        error: { code: "provider_outcome_unknown" },
      });
      expect(restarted.details).toMatchObject({
        status: "unknown",
        reattached: true,
      });
      expect(directFetch).toHaveBeenCalledTimes(1);
      expect(String(directFetch.mock.calls[0]?.[0])).toBe(expectedUrl);
      expect(managedFetch).not.toHaveBeenCalled();
    },
  );

  it("requires managed local-reference consent before any file read or upload", async () => {
    const stellaDataDir = tempDirs.create("image-gen-managed-consent-");
    const managedFetch = vi.fn() as unknown as typeof fetch;
    const result = await createHandler(managedFetch)(
      {
        prompt: "use my reference",
        referenceImagePaths: [path.join(stellaDataDir, "missing-private.png")],
      },
      contextFor(stellaDataDir),
    );
    expect(result.details).toMatchObject({
      status: "failed",
      error: { code: "managed_reference_consent_required" },
    });
    expect(managedFetch).not.toHaveBeenCalled();
  });

  it("rejects local references outside authorized workspace and attachment roots", async () => {
    const stellaDataDir = tempDirs.create("image-gen-reference-policy-");
    const outsideDir = tempDirs.create("image-gen-reference-outside-");
    const outsidePath = path.join(outsideDir, "reference.png");
    await writeFile(
      outsidePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const managedFetch = vi.fn() as unknown as typeof fetch;
    const result = await createHandler(managedFetch)(
      {
        prompt: "use outside file",
        referenceImagePaths: [outsidePath],
        allowManagedReferenceUpload: true,
      },
      contextFor(stellaDataDir),
    );
    expect(result.error).toContain("outside the active workspace");
    expect(managedFetch).not.toHaveBeenCalled();
  });

  it("authorizes production Fashion references and rejects an ancestor replacement race", async () => {
    const stellaDataDir = tempDirs.create("image-gen-fashion-reference-");
    const fashionDir = path.join(stellaDataDir, "fashion");
    const safeDir = path.join(stellaDataDir, "attachments", "safe");
    const outsideDir = tempDirs.create("image-gen-reference-race-outside-");
    await Promise.all([
      mkdir(fashionDir, { recursive: true }),
      mkdir(safeDir, { recursive: true }),
    ]);
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const bodyPath = path.join(fashionDir, "body.png");
    await writeFile(bodyPath, imageBytes);
    await expect(
      readAuthorizedImageReference(bodyPath, contextFor(stellaDataDir)),
    ).resolves.toMatchObject({ mimeType: "image/png" });

    const racedPath = path.join(safeDir, "reference.png");
    await writeFile(racedPath, imageBytes);
    await writeFile(path.join(outsideDir, "reference.png"), imageBytes);
    await expect(
      readAuthorizedImageReference(racedPath, contextFor(stellaDataDir), {
        afterOpen: async () => {
          await rename(safeDir, `${safeDir}-original`);
          await symlink(outsideDir, safeDir, "dir");
        },
      }),
    ).rejects.toThrow("outside the authorized directories");
  });
});
