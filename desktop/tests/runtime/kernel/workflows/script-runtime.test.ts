import { describe, expect, it, vi } from "vitest";
import {
  assertWorkflowScriptParses,
  runWorkflowScript,
  WorkflowScriptSyntaxError,
  type RunWorkflowScriptArgs,
  type WorkflowAgentOptions,
} from "../../../../../runtime/kernel/workflows/script-runtime.js";

type Overrides = Partial<Omit<RunWorkflowScriptArgs, "script">>;

const runScript = (script: string, overrides: Overrides = {}) =>
  runWorkflowScript({
    script,
    agent: overrides.agent ?? (async (prompt) => `echo:${prompt}`),
    log: overrides.log ?? (() => {}),
    signal: overrides.signal ?? new AbortController().signal,
    maxConcurrentAgents: overrides.maxConcurrentAgents ?? 4,
  });

/** Normalize vm-realm objects/arrays for structural assertions. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("runWorkflowScript", () => {
  it("supports top-level await and resolves the top-level return value", async () => {
    const agent = vi.fn(async (prompt: string) => prompt.toUpperCase());
    const result = await runScript(
      [
        'const a = await agent("alpha");',
        'const b = await agent("beta");',
        'return a + "|" + b;',
      ].join("\n"),
      { agent },
    );
    expect(result).toBe("ALPHA|BETA");
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it("exposes only the workflow primitives plus standard builtins in the sandbox", async () => {
    const result = await runScript(
      [
        "return {",
        "  process: typeof process,",
        "  require: typeof require,",
        "  setTimeout: typeof setTimeout,",
        "  fetch: typeof fetch,",
        "  agent: typeof agent,",
        "  parallel: typeof parallel,",
        "  pipeline: typeof pipeline,",
        "  log: typeof log,",
        "  json: typeof JSON,",
        "  math: typeof Math,",
        "  promise: typeof Promise,",
        "};",
      ].join("\n"),
    );
    expect(json(result)).toEqual({
      process: "undefined",
      require: "undefined",
      setTimeout: "undefined",
      fetch: "undefined",
      agent: "function",
      parallel: "function",
      pipeline: "function",
      log: "function",
      json: "object",
      math: "object",
      promise: "function",
    });
  });

  it("rejects agent() calls with an empty or non-string prompt without invoking the runner", async () => {
    const agent = vi.fn(async () => "never");
    const result = await runScript(
      [
        "const messages = [];",
        'try { await agent("   "); } catch (e) { messages.push(e.message); }',
        "try { await agent(42); } catch (e) { messages.push(e.message); }",
        "return messages;",
      ].join("\n"),
      { agent },
    );
    expect(json(result)).toEqual([
      "agent() requires a non-empty prompt string.",
      "agent() requires a non-empty prompt string.",
    ]);
    expect(agent).not.toHaveBeenCalled();
  });

  it("rejects immediately when the signal is already aborted, never calling the agent", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = vi.fn(async () => "never");
    await expect(
      runScript('return await agent("x");', {
        agent,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Workflow was canceled.");
    expect(agent).not.toHaveBeenCalled();
  });

  describe("parallel()", () => {
    it("resolves failed thunks and non-functions to null", async () => {
      const result = await runScript(
        [
          "return await parallel([",
          '  () => agent("one"),',
          '  async () => { throw new Error("branch failed"); },',
          '  "not-a-function",',
          '  async () => "plain",',
          "]);",
        ].join("\n"),
      );
      expect(json(result)).toEqual(["echo:one", null, null, "plain"]);
    });

    it("throws on a non-array argument", async () => {
      const result = await runScript(
        'try { await parallel("nope"); } catch (e) { return e.message; }',
      );
      expect(result).toBe("parallel() takes an array of zero-arg functions.");
    });
  });

  describe("pipeline()", () => {
    it("passes (previous, originalItem, index) to each stage and skips non-function stages", async () => {
      const result = await runScript(
        [
          "return await pipeline([10, 20],",
          "  (value) => value + 1,",
          '  "skipped",',
          "  (value, original, index) => [value, original, index]);",
        ].join("\n"),
      );
      expect(json(result)).toEqual([
        [11, 10, 0],
        [21, 20, 1],
      ]);
    });

    it("drops an item to null when one of its stages throws, keeping the others", async () => {
      const result = await runScript(
        [
          'return await pipeline(["keep", "drop"],',
          '  (value) => { if (value === "drop") throw new Error("nope"); return value.toUpperCase(); },',
          '  (value) => value + "!");',
        ].join("\n"),
      );
      expect(json(result)).toEqual(["KEEP!", null]);
    });

    it("throws on a non-array items argument", async () => {
      const result = await runScript(
        "try { await pipeline(123, (x) => x); } catch (e) { return e.message; }",
      );
      expect(result).toBe(
        "pipeline() takes an array of items as its first argument.",
      );
    });
  });

  it("limits in-flight agent callbacks to maxConcurrentAgents", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const agent = vi.fn(async (prompt: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return prompt;
    });
    const result = await runScript(
      [
        "return await parallel([",
        '  () => agent("1"),',
        '  () => agent("2"),',
        '  () => agent("3"),',
        '  () => agent("4"),',
        '  () => agent("5"),',
        "]);",
      ].join("\n"),
      { agent, maxConcurrentAgents: 2 },
    );
    expect(agent).toHaveBeenCalledTimes(5);
    expect(json(result)).toEqual(["1", "2", "3", "4", "5"]);
    expect(maxInFlight).toBe(2);
  });

  it("clamps maxConcurrentAgents to at least 1", async () => {
    const result = await runScript('return await agent("solo");', {
      maxConcurrentAgents: 0,
    });
    expect(result).toBe("echo:solo");
  });

  it("log() collapses whitespace, slices to 300 chars, and ignores non-strings", async () => {
    const logs: string[] = [];
    await runScript(
      [
        'log("  hello\\n   world  ");',
        'log("");',
        'log("   ");',
        "log(42);",
        "log({});",
        'log("x".repeat(400));',
        "return null;",
      ].join("\n"),
      { log: (message) => logs.push(message) },
    );
    expect(logs).toEqual(["hello world", "x".repeat(300)]);
  });

  it("rejects with 'Workflow was canceled.' when aborted mid-run", async () => {
    const controller = new AbortController();
    const agent = vi.fn(() => new Promise<never>(() => {}));
    const promise = runScript('return await agent("hang");', {
      agent,
      signal: controller.signal,
    });
    const settled = expect(promise).rejects.toThrow("Workflow was canceled.");
    await vi.waitFor(() => {
      expect(agent).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await settled;
  });

  it("sanitizes agent() options: trims labels, caps their length, drops array schemas", async () => {
    const seen: Array<WorkflowAgentOptions | undefined> = [];
    const agent = vi.fn(
      async (_prompt: string, opts?: WorkflowAgentOptions) => {
        seen.push(opts);
        return "ok";
      },
    );
    await runScript(
      [
        'await agent("a", { label: "  spaces  ", schema: [1, 2] });',
        'await agent("b", { label: "x".repeat(100), schema: { type: "object" } });',
        'await agent("c");',
        "return null;",
      ].join("\n"),
      { agent },
    );
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ label: "spaces" });
    expect(seen[0]).not.toHaveProperty("schema");
    expect(seen[1]?.label).toBe("x".repeat(80));
    expect(json(seen[1]?.schema)).toEqual({ type: "object" });
    expect(seen[2]).toEqual({});
  });
});

describe("assertWorkflowScriptParses", () => {
  it("passes for valid scripts, including top-level await and return", () => {
    expect(() =>
      assertWorkflowScriptParses(
        'const x = await agent("hi");\nreturn x;',
      ),
    ).not.toThrow();
  });

  it("throws WorkflowScriptSyntaxError naming the offending token for bad syntax", () => {
    expect(() => assertWorkflowScriptParses("const = ;")).toThrow(
      WorkflowScriptSyntaxError,
    );
    expect(() => assertWorkflowScriptParses("const = ;")).toThrow(
      /Workflow script has a syntax error: .*Unexpected token/,
    );
  });
});
