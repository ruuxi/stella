import {
  Agent,
  type AgentOptions,
  type SDKImage,
  type SDKMessage,
} from "@cursor/sdk";

const FORCE_EXIT_AFTER_SIGNAL_MS = 4_000;

type CursorNodeRunnerRequest = {
  agentOptions: AgentOptions;
  prompt: string | { text: string; images: SDKImage[] };
  runId: string;
  sessionKey: string;
  persistedSessionId?: string;
};

const writeEvent = (event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const readStdin = async (): Promise<string> => {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
  }
  return input;
};

const statusTextFromMessage = (message: SDKMessage): string | null => {
  if (message.type === "thinking" && message.text.trim()) {
    return message.text.trim();
  }
  if (message.type === "status") {
    return (message.message ?? message.status).trim();
  }
  if (message.type === "task" && message.text?.trim()) {
    return message.text.trim();
  }
  if (message.type === "tool_call") {
    return `${message.name} ${message.status}`.trim();
  }
  return null;
};

const main = async () => {
  const raw = await readStdin();
  const request = JSON.parse(raw) as CursorNodeRunnerRequest;
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let run:
    | Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>
    | undefined;
  let cancelRequested = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelRun = (signal: NodeJS.Signals) => {
    cancelRequested = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void run?.cancel().catch(() => undefined);
    if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => {
        process.exit(process.exitCode || 1);
      }, FORCE_EXIT_AFTER_SIGNAL_MS);
      forceExitTimer.unref?.();
    }
  };
  process.once("SIGTERM", cancelRun);
  process.once("SIGINT", cancelRun);

  try {
    agent = request.persistedSessionId
      ? await Agent.resume(request.persistedSessionId, request.agentOptions)
      : await Agent.create({
          ...request.agentOptions,
          name: "Stella General",
          idempotencyKey: request.sessionKey,
        });
    writeEvent({ type: "session", sessionId: agent.agentId });
    if (cancelRequested) {
      throw new Error("Aborted");
    }

    run = await agent.send(request.prompt, {
      idempotencyKey: request.runId,
      local: { force: true },
    });
    if (cancelRequested) {
      await run.cancel().catch(() => undefined);
      throw new Error("Aborted");
    }

    let collected = "";
    for await (const message of run.stream()) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type !== "text") continue;
          collected += block.text;
          writeEvent({ type: "stream", text: block.text });
        }
        continue;
      }
      const statusText = statusTextFromMessage(message);
      if (statusText) {
        writeEvent({ type: "status", text: statusText });
      }
    }

    const result = await run.wait();
    if (result.status === "cancelled") {
      throw new Error("Aborted");
    }
    if (result.status === "error") {
      throw new Error(result.result || "Cursor run failed.");
    }
    writeEvent({
      type: "result",
      text: (result.result ?? collected).trim(),
      sessionId: agent.agentId,
    });
  } finally {
    process.off("SIGTERM", cancelRun);
    process.off("SIGINT", cancelRun);
    if (forceExitTimer) clearTimeout(forceExitTimer);
    await agent?.[Symbol.asyncDispose]().catch(() => {
      try {
        agent?.close();
      } catch {
        // Best effort.
      }
    });
  }
};

void main().catch((error) => {
  writeEvent({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
  process.exitCode = 1;
});
