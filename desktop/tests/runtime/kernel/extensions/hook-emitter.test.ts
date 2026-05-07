import { describe, expect, it } from "vitest";
import { HookEmitter } from "../../../../../runtime/kernel/extensions/hook-emitter.js";

describe("HookEmitter", () => {
  describe("has", () => {
    it("returns false when no hook is registered for the event", () => {
      const emitter = new HookEmitter();
      expect(emitter.has("message_update")).toBe(false);
    });

    it("returns true when at least one hook is registered for the event", () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "message_update",
        handler: async () => undefined,
      });
      expect(emitter.has("message_update")).toBe(true);
      expect(emitter.has("agent_end")).toBe(false);
    });
  });

  describe("agent_end result merging", () => {
    it("merges selfModApplied across hooks instead of letting an empty extension result overwrite it", async () => {
      const emitter = new HookEmitter();
      const selfModPayload = {
        featureId: "feat-123",
        files: ["a.ts"],
        batchIndex: 0,
      };

      emitter.register({
        event: "agent_end",
        source: "bundled",
        handler: async () => ({
          selfModApplied: selfModPayload,
        }),
      });
      emitter.register({
        event: "agent_end",
        source: "extension",
        handler: async () => ({}),
      });

      const result = await emitter.emit(
        "agent_end",
        {
          agentType: "orchestrator",
          finalText: "done",
          outcome: "success",
          runId: "run-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(result).toBeDefined();
      expect(result).toEqual({ selfModApplied: selfModPayload });
    });

    it("lets a later hook override the same field (intentional opt-out)", async () => {
      const emitter = new HookEmitter();
      const earlier = {
        featureId: "old",
        files: [],
        batchIndex: 0,
      };
      const later = {
        featureId: "new",
        files: ["b.ts"],
        batchIndex: 1,
      };

      emitter.register({
        event: "agent_end",
        handler: async () => ({ selfModApplied: earlier }),
      });
      emitter.register({
        event: "agent_end",
        handler: async () => ({ selfModApplied: later }),
      });

      const result = await emitter.emit(
        "agent_end",
        {
          agentType: "orchestrator",
          finalText: "done",
          outcome: "success",
          runId: "run-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(result).toEqual({ selfModApplied: later });
    });

    it("preserves a single hook's result with no other consumers", async () => {
      const emitter = new HookEmitter();
      const payload = {
        featureId: "x",
        files: ["c.ts"],
        batchIndex: 0,
      };
      emitter.register({
        event: "agent_end",
        handler: async () => ({ selfModApplied: payload }),
      });

      const result = await emitter.emit(
        "agent_end",
        {
          agentType: "orchestrator",
          finalText: "ok",
          outcome: "success",
          runId: "run-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(result).toEqual({ selfModApplied: payload });
    });

    it("does not let a later hook erase a merged field by returning explicit undefined", async () => {
      // Regression: pre-fix, `{ ...merged, ...{ selfModApplied: undefined } }`
      // would write `undefined` over the prior payload — silently
      // breaking the morph-overlay contract. The docstring says
      // "undefined is skipped"; this pins that behavior at the impl
      // layer too.
      const emitter = new HookEmitter();
      const payload = {
        featureId: "feat-1",
        files: ["a.ts"],
        batchIndex: 0,
      };

      emitter.register({
        event: "agent_end",
        source: "bundled",
        handler: async () => ({ selfModApplied: payload }),
      });
      emitter.register({
        event: "agent_end",
        source: "extension",
        // Explicit-undefined return: must NOT erase the earlier hook's
        // contribution.
        handler: async () => ({ selfModApplied: undefined }),
      });

      const result = await emitter.emit(
        "agent_end",
        {
          agentType: "orchestrator",
          finalText: "done",
          outcome: "success",
          runId: "run-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(result).toEqual({ selfModApplied: payload });
    });
  });

  describe("clearBySource preserves bundled hooks", () => {
    it("leaves bundled hooks intact when only extension hooks are swept (F1 invariant)", async () => {
      const emitter = new HookEmitter();
      let bundledCalls = 0;
      let extensionCalls = 0;
      emitter.register({
        event: "before_agent_start",
        source: "bundled",
        handler: async () => {
          bundledCalls += 1;
          return { systemPromptReplace: "from-bundled" };
        },
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => {
          extensionCalls += 1;
          return { systemPromptAppend: "from-extension" };
        },
      });

      emitter.clearBySource("extension");

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(bundledCalls).toBe(1);
      expect(extensionCalls).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ systemPromptReplace: "from-bundled" });
    });

    it("treats source-less hooks as extension (legacy registrations)", () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "agent_end",
        handler: async () => undefined,
      });
      expect(emitter.has("agent_end")).toBe(true);
      emitter.clearBySource("extension");
      expect(emitter.has("agent_end")).toBe(false);
    });
  });

  describe("emitAll ordering composition", () => {
    it("returns every non-empty result in registration order", async () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "before_agent_start",
        source: "bundled",
        handler: async () => ({ systemPromptReplace: "personality" }),
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => ({ systemPromptAppend: "ext-1" }),
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => null,
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => ({ systemPromptAppend: "ext-2" }),
      });

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(results).toEqual([
        { systemPromptReplace: "personality" },
        { systemPromptAppend: "ext-1" },
        { systemPromptAppend: "ext-2" },
      ]);
    });

    it("returns an empty array when no hooks are registered", async () => {
      const emitter = new HookEmitter();
      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );
      expect(results).toEqual([]);
    });

    it("swallows individual hook errors and continues with the rest", async () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "before_agent_start",
        handler: async () => ({ systemPromptReplace: "first" }),
      });
      emitter.register({
        event: "before_agent_start",
        handler: async () => {
          throw new Error("buggy extension");
        },
      });
      emitter.register({
        event: "before_agent_start",
        handler: async () => ({ systemPromptAppend: "third" }),
      });

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(results).toEqual([
        { systemPromptReplace: "first" },
        { systemPromptAppend: "third" },
      ]);
    });
  });
});
