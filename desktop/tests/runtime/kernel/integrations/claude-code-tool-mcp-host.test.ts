import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClaudeCodeToolMcpHost,
  type ClaudeCodeToolMcpActiveTurn,
  type ClaudeCodeToolMcpHost,
} from "../../../../../runtime/kernel/integrations/claude-code-tool-mcp-host.js";
import {
  markImageOperationDelivered,
  reserveDurableImageOperation,
  settleImageOperation,
} from "../../../../../runtime/kernel/tools/image-operation-store.js";
import { createImageGenTool } from "../../../../../runtime/kernel/tools/defs/image-gen.js";

const tools = [
  {
    name: "get_weather",
    description: "Get the current weather",
    parameters: {
      type: "object" as const,
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "fail_tool",
    description: "Return a Stella tool error",
    parameters: { type: "object" as const },
  },
];

const imageTools = [createImageGenTool({})];

const connect = async (host: ClaudeCodeToolMcpHost) => {
  const client = new Client(
    { name: "stella-claude-mcp-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: {
      headers: { Authorization: host.authorizationHeader },
    },
  });
  await client.connect(transport);
  return client;
};

describe("claude-code-tool-mcp-host", () => {
  const hosts = new Set<ClaudeCodeToolMcpHost>();
  const clients = new Set<Client>();

  afterEach(async () => {
    await Promise.allSettled([...clients].map((client) => client.close()));
    await Promise.allSettled([...hosts].map((host) => host.close()));
    clients.clear();
    hosts.clear();
  });

  it("does not admit the first prompt until the MCP catalog response is flushed", async () => {
    const host = await createClaudeCodeToolMcpHost({
      tools: imageTools,
      getActiveTurn: () => undefined,
    });
    hosts.add(host);
    let ready = false;
    const readyPromise = host.waitForClientReady(undefined, 2_000).then(() => {
      ready = true;
    });
    const client = await connect(host);
    clients.add(client);
    await Promise.resolve();
    expect(ready).toBe(false);

    const catalog = await client.listTools();
    expect(catalog.tools[0]?.name).toBe("image_gen");
    expect(catalog.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["prompt"],
      allOf: expect.any(Array),
    });
    await readyPromise;
    expect(ready).toBe(true);
  });

  it("publishes only the immutable allowlist and routes native calls to the active turn", async () => {
    const executeTool = vi.fn<ClaudeCodeToolMcpActiveTurn["executeTool"]>(
      async (_id, name, args, _signal, onUpdate) => {
        onUpdate?.({ result: "halfway" });
        return {
          result: `${name}:${String(args.city)}`,
          details: { source: "test" },
          fileChanges: [{ path: "/tmp/weather.txt", kind: { type: "update" } }],
        };
      },
    );
    const onToolUpdate = vi.fn();
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({ executeTool, onToolUpdate }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
    expect(host.authorizationHeader).toMatch(/^Bearer /);
    expect(host.toolCatalogHash).toMatch(/^[a-f0-9]{64}$/);
    expect(host.mcpServerConfig).toEqual({
      type: "http",
      url: host.url,
      headers: { Authorization: host.authorizationHeader },
    });

    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "get_weather",
      "fail_tool",
    ]);
    expect(catalog.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["city"],
    });

    const progress = vi.fn();
    const result = await client.callTool(
      { name: "get_weather", arguments: { city: "Paris" } },
      undefined,
      { onprogress: progress },
    );
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]?.[0]).toMatch(/^mcp:/);
    expect(executeTool.mock.calls[0]?.[1]).toBe("get_weather");
    expect(executeTool.mock.calls[0]?.[2]).toEqual({ city: "Paris" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("get_weather:Paris"),
      },
    ]);
    // File-change accounting stays on Stella's internal turn result and is
    // not reflected back into Claude's tool payload.
    expect(JSON.stringify(result.content)).not.toContain("/tmp/weather.txt");
    expect(onToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_weather",
        update: { result: "halfway" },
      }),
    );
    expect(progress).toHaveBeenCalled();
  });

  it("returns Stella tool errors and rejects unknown tools", async () => {
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({
        executeTool: async () => ({ result: "", error: "tool exploded" }),
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    const failed = await client.callTool({ name: "fail_tool", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([
      { type: "text", text: "Error: tool exploded" },
    ]);
    await expect(
      client.callTool({ name: "not_allowlisted", arguments: {} }),
    ).rejects.toThrow("Tool is not available in this Stella session");
  });

  it("preserves details while capping combined model-visible tool text", async () => {
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({
        executeTool: async () => ({
          result: "r".repeat(50_000),
          details: { trace: "d".repeat(50_000) },
        }),
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    const result = await client.callTool({
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    const text = result.content[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Expected MCP text output");
    expect(text.text).toContain('"details"');
    expect(text.text).toContain('"trace"');
    expect(text.text).toContain("...[tool result truncated]");
    expect(text.text.length).toBeLessThan(80_100);
  });

  it("evicts the oldest settled call-ledger entry after the bounded window", async () => {
    const executeTool = vi.fn<ClaudeCodeToolMcpActiveTurn["executeTool"]>(
      async (_id, _name, args) => ({ result: String(args.index) }),
    );
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({ executeTool }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    for (let index = 0; index < 513; index += 1) {
      await client.callTool({
        name: "get_weather",
        arguments: { city: "Paris", index },
      });
    }
    expect(executeTool).toHaveBeenCalledTimes(513);
    const firstRequestId = Number(
      String(executeTool.mock.calls[0]?.[0]).split(":").at(-1),
    );
    expect(Number.isFinite(firstRequestId)).toBe(true);

    // Reuse the first native request id. Once the 512-entry settled window
    // rolls over, this must execute again rather than retaining/replaying the
    // old large result forever.
    (
      client as unknown as {
        _requestMessageId: number;
      }
    )._requestMessageId = firstRequestId;
    await client.callTool({
      name: "get_weather",
      arguments: { city: "Paris", index: "retried" },
    });
    expect(executeTool).toHaveBeenCalledTimes(514);
  });

  it("accepts a fresh Claude MCP client after the prior process disconnects", async () => {
    const executeTool = vi.fn<ClaudeCodeToolMcpActiveTurn["executeTool"]>(
      async (_id, _name, args) => ({ result: `weather:${String(args.city)}` }),
    );
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({ executeTool }),
    });
    hosts.add(host);

    const first = await connect(host);
    expect((await first.listTools()).tools).toHaveLength(2);
    await first.close();

    const second = await connect(host);
    clients.add(second);
    const result = await second.callTool({
      name: "get_weather",
      arguments: { city: "Phoenix" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "weather:Phoenix" }]);
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("keeps image_gen identity stable across a real MCP host/process restart", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-image-replay-"),
    );
    const callIds: string[] = [];
    let submissions = 0;
    let acknowledgements = 0;
    const create = async () => {
      const host = await createClaudeCodeToolMcpHost({
        tools: imageTools,
        identityScope: "persisted-claude-session-key",
        getActiveTurn: () => ({
          identityScope: "persisted-claude-session-key:durable-run-id",
          claimNativeToolUseId: async () => "toolu_persisted_image_1",
          executeTool: async (id, _name, args) => {
            callIds.push(id);
            const operation = reserveDurableImageOperation({
              stellaDataDir: dir,
              conversationId: "claude-mcp-response-replay",
              toolCallId: id,
              requestBody: args,
            });
            if (!operation.terminalResult) {
              submissions += 1;
              settleImageOperation({
                stellaDataDir: dir,
                operationId: operation.operationId,
                result: {
                  ok: true,
                  job: {
                    jobId: "job-stable",
                    capability: "text_to_image",
                    profile: "best",
                    status: "succeeded",
                  },
                  filePaths: [],
                  artifacts: [],
                  reattached: false,
                },
              });
            }
            return {
              result:
                operation.terminalResult ??
                ({ jobId: "job-stable", status: "succeeded" } as const),
              details: { jobId: "job-stable", status: "succeeded" },
            };
          },
          onToolResponseWritten: ({ toolCallId }) => {
            acknowledgements += 1;
            markImageOperationDelivered({
              stellaDataDir: dir,
              conversationId: "claude-mcp-response-replay",
              toolCallId,
            });
          },
        }),
      });
      hosts.add(host);
      return host;
    };

    const firstHost = await create();
    const firstClient = await connect(firstHost);
    await firstClient.callTool({
      name: "image_gen",
      arguments: { prompt: "durable fox" },
    });
    await vi.waitFor(() => expect(acknowledgements).toBe(1));
    await firstClient.close();
    await firstHost.close();
    hosts.delete(firstHost);

    const restartedHost = await create();
    const restartedClient = await connect(restartedHost);
    clients.add(restartedClient);
    await restartedClient.callTool({
      name: "image_gen",
      arguments: { prompt: "durable fox" },
    });
    await vi.waitFor(() => expect(acknowledgements).toBe(2));

    expect(callIds).toHaveLength(2);
    expect(callIds[1]).toBe(callIds[0]);
    expect(callIds[0]).toMatch(/^claude:[a-f0-9]{24}:toolu_persisted_image_1:/);
    expect(submissions).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reattaches when Claude loses the MCP response around the HTTP finish acknowledgement", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-image-response-loss-"),
    );
    let submissions = 0;
    let acknowledgements = 0;
    let releaseFirst!: () => void;
    let announceTerminal!: () => void;
    const firstMayReturn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const terminalPersisted = new Promise<void>((resolve) => {
      announceTerminal = resolve;
    });
    const makeTurn = (blockResponse: boolean): ClaudeCodeToolMcpActiveTurn => ({
      identityScope: "claude-session:claude-durable-run",
      claimNativeToolUseId: async () => "toolu_response_loss_image",
      executeTool: async (toolCallId, _toolName, args) => {
        const operation = reserveDurableImageOperation({
          stellaDataDir: dir,
          conversationId: "claude-before-response-write",
          toolCallId,
          requestBody: args,
        });
        if (!operation.terminalResult) {
          submissions += 1;
          settleImageOperation({
            stellaDataDir: dir,
            operationId: operation.operationId,
            result: {
              ok: true,
              job: {
                jobId: "claude-response-loss-job",
                capability: "text_to_image",
                profile: "best",
                status: "succeeded",
              },
              filePaths: [],
              artifacts: [],
              reattached: false,
            },
          });
        }
        announceTerminal();
        if (blockResponse) await firstMayReturn;
        return { result: operation.terminalResult ?? { status: "succeeded" } };
      },
      onToolResponseWritten: ({ toolCallId }) => {
        acknowledgements += 1;
        markImageOperationDelivered({
          stellaDataDir: dir,
          conversationId: "claude-before-response-write",
          toolCallId,
        });
      },
    });
    try {
      const firstHost = await createClaudeCodeToolMcpHost({
        tools: imageTools,
        getActiveTurn: () => makeTurn(true),
      });
      hosts.add(firstHost);
      const firstClient = await connect(firstHost);
      clients.add(firstClient);
      const lostResponse = new AbortController();
      const lost = firstClient.callTool(
        {
          name: "image_gen",
          arguments: { prompt: "persist before response" },
        },
        undefined,
        { signal: lostResponse.signal },
      );
      await terminalPersisted;
      lostResponse.abort(new Error("Claude process crashed"));
      await expect(lost).rejects.toThrow();
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Node's server-side `finish` is the latest observable boundary. The
      // client can still disappear without consuming those bytes, so replay
      // must remain safe even though delivery was acknowledged.
      expect(acknowledgements).toBe(1);
      await firstHost.close();
      hosts.delete(firstHost);

      const restartedHost = await createClaudeCodeToolMcpHost({
        tools: imageTools,
        getActiveTurn: () => makeTurn(false),
      });
      hosts.add(restartedHost);
      const restartedClient = await connect(restartedHost);
      clients.add(restartedClient);
      await restartedClient.callTool({
        name: "image_gen",
        arguments: { prompt: "persist before response" },
      });
      await vi.waitFor(() => expect(acknowledgements).toBe(2));
      expect(submissions).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("separates a reused MCP request alias when the canonical image request changes", async () => {
    const callIds: string[] = [];
    let nativeInvocation = 0;
    const host = await createClaudeCodeToolMcpHost({
      tools: imageTools,
      identityScope: "persisted-alias-collision-scope",
      getActiveTurn: () => ({
        claimNativeToolUseId: async () =>
          `toolu_intentional_${++nativeInvocation}`,
        executeTool: async (id) => {
          callIds.push(id);
          return { result: { status: "succeeded" } };
        },
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);
    const forceAlias = () => {
      (client as unknown as { _requestMessageId: number })._requestMessageId =
        77;
    };
    forceAlias();
    await client.callTool({
      name: "image_gen",
      arguments: { prompt: "first intentional image" },
    });
    forceAlias();
    await client.callTool({
      name: "image_gen",
      arguments: { prompt: "different intentional image" },
    });
    expect(callIds).toHaveLength(2);
    expect(callIds[1]).not.toBe(callIds[0]);
  });

  it("delivers structured image failure and preserves image cancellation", async () => {
    let mode: "failure" | "cancel" = "failure";
    let nativeInvocation = 0;
    const host = await createClaudeCodeToolMcpHost({
      tools: imageTools,
      identityScope: "failure-cancel-session",
      getActiveTurn: () => ({
        claimNativeToolUseId: async () =>
          `toolu_failure_cancel_${++nativeInvocation}`,
        executeTool: async (_id, _name, _args, signal) => {
          if (mode === "failure") {
            return {
              error: "Image request was blocked.",
              details: {
                jobId: "job-failed",
                status: "failed",
                error: {
                  code: "policy",
                  message: "Image request was blocked.",
                },
              },
            };
          }
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("canceled")),
              {
                once: true,
              },
            );
          });
        },
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);
    const failed = await client.callTool({
      name: "image_gen",
      arguments: { prompt: "blocked" },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain(
      "Image request was blocked",
    );

    mode = "cancel";
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "image_gen", arguments: { prompt: "cancel me" } },
      undefined,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("drops stale client sessions on process reset while keeping the host alive", async () => {
    const executeTool = vi.fn<ClaudeCodeToolMcpActiveTurn["executeTool"]>(
      async () => ({ result: "fresh client result" }),
    );
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({ executeTool }),
    });
    hosts.add(host);

    const first = await connect(host);
    clients.add(first);
    expect((await first.listTools()).tools).toHaveLength(2);
    await host.resetClientSessions(new Error("Claude process died"));

    await expect(first.listTools()).rejects.toThrow();

    const second = await connect(host);
    clients.add(second);
    const result = await second.callTool({
      name: "get_weather",
      arguments: { city: "Phoenix" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "fresh client result" },
    ]);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(await fetch(host.url)).toMatchObject({ status: 401 });
  });

  it("requires the private bearer credential", async () => {
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => undefined,
    });
    hosts.add(host);

    const response = await fetch(host.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("forwards native MCP request cancellation to Stella tool execution", async () => {
    let observedSignal: AbortSignal | undefined;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({
        executeTool: async (_id, _name, _args, signal) => {
          observedSignal = signal;
          announceStarted();
          return await new Promise((resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("tool aborted")),
              { once: true },
            );
          });
        },
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);
    const controller = new AbortController();

    const pending = client.callTool(
      { name: "get_weather", arguments: { city: "Paris" } },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  });

  it("aborts calls owned by a dying Claude process without closing the host", async () => {
    let immediate = false;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({
        executeTool: async (_id, _name, _args, signal) => {
          if (immediate) return { result: "host still available" };
          announceStarted();
          return await new Promise((resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("process died")),
              { once: true },
            );
          });
        },
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    const pending = client.callTool({
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    await started;
    host.abortActiveCalls(new Error("Claude process died"));
    await expect(pending).rejects.toThrow();

    immediate = true;
    const recovered = await client.callTool({
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    expect(recovered.content).toEqual([
      { type: "text", text: "host still available" },
    ]);
  });

  it("aborts in-flight tools and releases the listener on cleanup", async () => {
    let observedSignal: AbortSignal | undefined;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const host = await createClaudeCodeToolMcpHost({
      tools,
      getActiveTurn: () => ({
        executeTool: async (_id, _name, _args, signal) => {
          observedSignal = signal;
          announceStarted();
          return await new Promise((resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("tool aborted")),
              { once: true },
            );
          });
        },
      }),
    });
    hosts.add(host);
    const client = await connect(host);
    clients.add(client);

    const pending = client.callTool({
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    await started;
    await host.close();
    hosts.delete(host);

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
    await expect(
      fetch(host.url, {
        headers: { Authorization: host.authorizationHeader },
      }),
    ).rejects.toThrow();
  });

  it("converts Stella inline-image results into native MCP image blocks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-mcp-image-"));
    try {
      const imagePath = path.join(dir, "snapshot.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPZP5QAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(imagePath, bytes);
      const host = await createClaudeCodeToolMcpHost({
        tools,
        getActiveTurn: () => ({
          executeTool: async () => ({
            result:
              "visible tree\n" +
              `[stella-attach-image][ 1x1][ 1KB][ inline=image/png] ${imagePath}`,
          }),
        }),
      });
      hosts.add(host);
      const client = await connect(host);
      clients.add(client);

      const result = await client.callTool({
        name: "get_weather",
        arguments: { city: "Paris" },
      });
      expect(result.content).toEqual([
        { type: "text", text: "visible tree" },
        {
          type: "image",
          data: bytes.toString("base64"),
          mimeType: "image/png",
        },
      ]);
      expect(JSON.stringify(result.content)).not.toContain(
        "[stella-attach-image]",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
