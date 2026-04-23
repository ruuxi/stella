import { useCallback, useEffect, useRef, useState } from "react";
import type { SelfModFeatureSummary } from "@/shared/types/electron";
import "./error-boundary.css";

type Props = {
  error: Error | null;
  componentStack: string | null;
};

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

const buildAutoRepairPrompt = (error: Error, componentStack: string) => {
  const stack = componentStack.trim() || "(no component stack)";
  return `A render crash happened in Stella's frontend.

Please perform an automatic self-repair now:
1. Find and fix the root cause in the frontend code.
2. Keep behavior changes minimal and safe.
3. Validate with frontend typecheck/tests when possible.
4. If you make code changes, commit them with a stable [feature:auto-repair] tag.

Crash details:
- Error: ${error.name}: ${error.message}
- Component stack:
${stack}

After fixing, return a concise summary of what you changed.`;
};

/**
 * Renderless-of-itself crash UI. Used by both the React `ErrorBoundary`
 * (for crashes outside the router) and the router's `defaultErrorComponent`
 * (for crashes that TanStack Router intercepts during route rendering /
 * loaders, which never reach a React error boundary upstream).
 */
export function CrashSurface({ error, componentStack }: Props) {
  const [revertingFeatureId, setRevertingFeatureId] = useState<string | null>(
    null,
  );
  const [, setFeatures] = useState<SelfModFeatureSummary[]>([]);
  const [repairStatus, setRepairStatus] = useState<
    "idle" | "running" | "failed"
  >("idle");
  const [repairMessage, setRepairMessage] = useState("");
  const startedRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const features = await window.electronAPI?.agent.listSelfModFeatures(5);
        if (!cancelled) setFeatures(features ?? []);
      } catch (loadError) {
        console.error("CrashSurface feature load failed:", loadError);
        if (!cancelled) setFeatures([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRevert = useCallback(async (featureId?: string) => {
    setRevertingFeatureId(featureId ?? "__latest__");
    try {
      await window.electronAPI?.agent.selfModRevert(featureId, 1);
    } catch (err) {
      console.error("CrashSurface revert failed:", err);
    } finally {
      window.location.reload();
    }
  }, []);

  const handleRepair = useCallback(async () => {
    if (repairStatus === "running" || !error) return;

    const api = window.electronAPI;
    if (
      !api?.agent?.startChat
      || !api?.agent?.healthCheck
      || !api?.ui?.getState
    ) {
      setRepairStatus("failed");
      setRepairMessage("Repair is unavailable right now.");
      return;
    }

    const health = await api.agent.healthCheck();
    if (!health?.ready) {
      setRepairStatus("failed");
      setRepairMessage("Repair is unavailable right now.");
      return;
    }

    const stack = componentStack ?? "";
    const signature = `${error.name}:${error.message}:${stack}`.slice(0, 12_000);
    const previousSignature = sessionStorage.getItem(AUTO_REPAIR_SIGNATURE_KEY);
    if (previousSignature === signature) {
      setRepairStatus("failed");
      setRepairMessage("A repair was already attempted for this crash.");
      return;
    }
    sessionStorage.setItem(AUTO_REPAIR_SIGNATURE_KEY, signature);

    setRepairStatus("running");
    setRepairMessage("Stella is fixing this...");

    try {
      const uiState = await api.ui.getState();
      const conversationId =
        typeof uiState?.conversationId === "string"
        && uiState.conversationId.trim()
          ? uiState.conversationId
          : null;
      if (!conversationId) {
        throw new Error("No active conversation for repair.");
      }

      const prompt = buildAutoRepairPrompt(error, stack);

      const { requestId } = await api.agent.startChat({
        conversationId,
        userPrompt: prompt,
        agentType: "orchestrator",
        storageMode: "local",
      });

      const unsubscribe = api.agent.onStream((event) => {
        if (event.type === "run-started" && event.requestId === requestId) {
          startedRunIdRef.current = event.runId;
          return;
        }

        if (
          event.type !== "run-finished"
          || (event.requestId !== requestId
            && event.runId !== startedRunIdRef.current)
        ) {
          return;
        }

        if (event.outcome === "completed") {
          unsubscribe();
          window.location.reload();
          return;
        }

        unsubscribe();
        setRepairStatus("failed");
        setRepairMessage(
          "Repair could not complete. You can undo recent updates below.",
        );
      });
    } catch (repairError) {
      console.error("CrashSurface repair failed:", repairError);
      setRepairStatus("failed");
      setRepairMessage(
        "Repair could not start. You can undo recent updates below.",
      );
    }
  }, [componentStack, error, repairStatus]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div className="error-boundary">
      <div className="error-boundary-gradient" />
      <div className="error-boundary-content">
        <h2>Something went wrong</h2>
        <p>
          An unexpected error occurred. You can try undoing recent changes or
          reloading.
        </p>
        {repairStatus !== "idle" && (
          <p className="error-boundary-status">{repairMessage}</p>
        )}
        <div className="error-boundary-actions">
          {repairStatus === "idle" && error && (
            <button
              className="error-boundary-btn error-boundary-btn--fix"
              onClick={handleRepair}
            >
              Ask Stella to fix
            </button>
          )}
          <button
            className="error-boundary-btn"
            onClick={() => handleRevert()}
            disabled={revertingFeatureId !== null}
          >
            {revertingFeatureId ? "Reverting..." : "Undo"}
          </button>
          <button className="error-boundary-btn" onClick={handleReload}>
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
