/**
 * Top-level dispatcher for the Store agent's pending tool calls.
 *
 * Mounted once at the app shell so the agent can finish a turn even
 * when the user closes the side panel or switches to a different
 * display tab. Without this, an agent waiting on `git_show` would
 * time out after 5 minutes of polling.
 *
 * The dispatcher subscribes to the per-owner pending-tool-call queue
 * and routes by tool name:
 *  - `ask_question`: surface a global modal with the options. The
 *    user's pick is posted back as the tool result; the agent
 *    continues from there.
 *  - everything else: forward to the local tool executor IPC and
 *    post the result back.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { showToast } from "@/ui/toast";

type PendingToolCallRow = {
  _id: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
};

type AskQuestionPayload = {
  toolCallId: string;
  deviceId: string;
  question: string;
  options: string[];
};

function AskQuestionModal({
  payload,
  onAnswered,
}: {
  payload: AskQuestionPayload;
  onAnswered: () => void;
}) {
  const completeToolCall = useMutation(api.data.store_thread.completeToolCall);
  const [busy, setBusy] = useState(false);

  const pick = async (option: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await completeToolCall({
        toolCallId: payload.toolCallId,
        deviceId: payload.deviceId,
        status: "complete",
        resultText: `User picked: ${option}`,
      });
      onAnswered();
    } catch (error) {
      showToast({
        title: "Could not submit answer",
        description: (error as Error)?.message,
        variant: "error",
      });
      setBusy(false);
    }
  };

  return (
    <div className="store-agent-ask-question-modal">
      <div className="store-agent-ask-question-card">
        <div className="store-agent-ask-question-title">{payload.question}</div>
        <div className="store-agent-ask-question-options">
          {payload.options.map((option) => (
            <button
              key={option}
              type="button"
              className="pill-btn"
              disabled={busy}
              onClick={() => void pick(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StoreAgentToolDispatcher() {
  const { hasSession } = useAuthSessionState();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const pending = useQuery(
    api.data.store_thread.peekPendingToolCall,
    hasSession && deviceId ? { deviceId } : "skip",
  );
  const completeToolCall = useMutation(api.data.store_thread.completeToolCall);
  const inFlightRef = useRef<Set<string>>(new Set());
  const [askQuestion, setAskQuestion] = useState<AskQuestionPayload | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.system
      ?.getDeviceId?.()
      .then((nextDeviceId) => {
        if (!cancelled) setDeviceId(nextDeviceId?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setDeviceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pending || !deviceId) return;
    const row = pending as PendingToolCallRow;
    if (inFlightRef.current.has(row.toolCallId)) return;
    inFlightRef.current.add(row.toolCallId);

    const dispatch = async () => {
      if (row.toolName === "ask_question") {
        let parsedArgs: { question?: string; options?: string[] } = {};
        try {
          parsedArgs = JSON.parse(row.argsJson) as typeof parsedArgs;
        } catch {
          await completeToolCall({
            toolCallId: row.toolCallId,
            deviceId,
            status: "error",
            errorMessage: "ask_question received malformed arguments.",
          });
          return;
        }
        const question = (parsedArgs.question ?? "").trim();
        const options = (parsedArgs.options ?? [])
          .map((option) => option.trim())
          .filter(Boolean);
        if (!question || options.length < 2) {
          await completeToolCall({
            toolCallId: row.toolCallId,
            deviceId,
            status: "error",
            errorMessage:
              "ask_question requires a question and at least 2 options.",
          });
          return;
        }
        setAskQuestion({
          toolCallId: row.toolCallId,
          deviceId,
          question,
          options,
        });
        return;
      }

      const electronStore = window.electronAPI?.store;
      if (!electronStore?.executeAgentTool) {
        await completeToolCall({
          toolCallId: row.toolCallId,
          deviceId,
          status: "error",
          errorMessage: "Local tool executor is unavailable.",
        });
        return;
      }
      try {
        const result = await electronStore.executeAgentTool({
          toolName: row.toolName,
          argsJson: row.argsJson,
        });
        await completeToolCall({
          toolCallId: row.toolCallId,
          deviceId,
          status: result.isError ? "error" : "complete",
          ...(result.isError
            ? { errorMessage: result.resultText }
            : { resultText: result.resultText }),
        });
      } catch (error) {
        await completeToolCall({
          toolCallId: row.toolCallId,
          deviceId,
          status: "error",
          errorMessage: (error as Error)?.message ?? "Tool execution failed.",
        });
      }
    };

    void dispatch();
  }, [pending, completeToolCall, deviceId]);

  if (askQuestion) {
    return (
      <AskQuestionModal
        payload={askQuestion}
        onAnswered={() => setAskQuestion(null)}
      />
    );
  }
  return null;
}

export default StoreAgentToolDispatcher;
