import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../../../runtime/kernel/agent-core/types.js";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "../../../../../runtime/kernel/agent-runtime/run-events.js";
import {
  reserveDurableImageOperation,
  settleImageOperation,
} from "../../../../../runtime/kernel/tools/image-operation-store.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

describe("native image terminal delivery recovery", () => {
  it("persists the tool result before ACK and reattaches across both crash windows", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-native-image-ack-"),
    );
    const db = new DatabaseSync(
      getDesktopDatabasePath(dataDir),
    ) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    const store = new SessionStore(db);
    const conversationId = "native-image-conversation";
    const toolCallId = "native-image-call";
    const requestBody = { capability: "text_to_image", prompt: "durable fox" };
    const first = reserveDurableImageOperation({
      stellaDataDir: dataDir,
      conversationId,
      toolCallId,
      requestBody,
    });
    settleImageOperation({
      stellaDataDir: dataDir,
      operationId: first.operationId,
      result: {
        ok: false,
        jobId: "job-native-crash",
        status: "failed",
        code: "provider_failure",
        message: "terminal result",
        reattached: false,
      },
    });

    // Crash after terminal completion but before message_end persistence:
    // the same production ledger identity must still reattach.
    const beforePersistenceRestart = reserveDurableImageOperation({
      stellaDataDir: dataDir,
      conversationId,
      toolCallId,
      requestBody,
    });
    expect(beforePersistenceRestart.operationId).toBe(first.operationId);
    expect(beforePersistenceRestart.terminalResult).toMatchObject({
      code: "provider_failure",
      reattached: true,
    });

    const listeners = new Set<(event: AgentEvent) => void>();
    const agent = {
      state: { messages: [] },
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const subscribe = (injectCrash: boolean) =>
      subscribeRuntimeAgentEvents({
        agent,
        runId: "native-image-run",
        agentType: "orchestrator",
        recorder: createRunEventRecorder({
          store,
          runId: "native-image-run",
          conversationId,
          agentType: "orchestrator",
          userMessageId: "native-image-user",
        }),
        threadStore: store,
        threadKey: conversationId,
        conversationId,
        stellaDataDir: dataDir,
        ...(injectCrash
          ? {
              afterDurableMessagePersisted: () => {
                throw new Error("injected crash before image delivery ACK");
              },
            }
          : {}),
      });
    const event = {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "image_gen",
        content: [{ type: "text", text: "terminal result" }],
        isError: true,
        timestamp: Date.now(),
      },
    } as AgentEvent;

    const unsubscribeCrashed = subscribe(true);
    expect(() => {
      for (const listener of listeners) listener(event);
    }).toThrow("injected crash");
    unsubscribeCrashed();
    const afterPersistCrash = reserveDurableImageOperation({
      stellaDataDir: dataDir,
      conversationId,
      toolCallId,
      requestBody,
    });
    expect(afterPersistCrash.operationId).toBe(first.operationId);

    const unsubscribeRestarted = subscribe(false);
    for (const listener of listeners) listener(event);
    unsubscribeRestarted();
    const acknowledgedReplay = reserveDurableImageOperation({
      stellaDataDir: dataDir,
      conversationId,
      toolCallId,
      requestBody,
    });
    expect(acknowledgedReplay.operationId).toBe(first.operationId);
    expect(acknowledgedReplay.terminalResult).toMatchObject({
      ok: false,
      reattached: true,
    });
    const intentionalNewCall = reserveDurableImageOperation({
      stellaDataDir: dataDir,
      conversationId,
      toolCallId: `${toolCallId}:next-run`,
      requestBody,
    });
    expect(intentionalNewCall.operationId).not.toBe(first.operationId);

    (db as unknown as { close: () => void }).close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
