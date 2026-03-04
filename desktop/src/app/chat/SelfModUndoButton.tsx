import { useState, useCallback } from "react";
import { showToast } from "@/ui/toast";

export type SelfModApplied = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

export function SelfModUndoButton({
  selfModApplied,
}: {
  selfModApplied: SelfModApplied;
}) {
  const [state, setState] = useState<"idle" | "reverting" | "reverted">("idle");

  const handleUndo = useCallback(async () => {
    if (state !== "idle") return;
    setState("reverting");
    try {
      await window.electronAPI?.agent.selfModRevert(selfModApplied.featureId, 1);
      setState("reverted");
    } catch (err) {
      console.error("Self-mod revert failed:", err);
      showToast({ title: "Failed to undo changes", variant: "error" });
      setState("idle");
    }
  }, [selfModApplied.featureId, state]);

  return (
    <button
      className="selfmod-undo-btn"
      data-state={state}
      onClick={handleUndo}
      disabled={state !== "idle"}
    >
      {state === "reverting" ? (
        <>
          <span className="selfmod-undo-spinner" />
          Reverting...
        </>
      ) : state === "reverted" ? (
        "Reverted"
      ) : (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 10h10a5 5 0 0 1 0 10H13" />
            <path d="M7 14L3 10l4-4" />
          </svg>
          Undo changes
        </>
      )}
    </button>
  );
}

