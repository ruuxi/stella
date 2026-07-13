import { useState, useCallback, useEffect, useRef } from "react";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { showToast } from "@/ui/toast";
import type { SelfModApplied } from "@/features/chat/self-mod-types";
import "./selfmod-undo.css";

export type { SelfModApplied } from "@/features/chat/self-mod-types";

type ButtonState =
  | "pending"
  | "applying"
  | "idle"
  | "confirming"
  | "reverting"
  | "reverted";

// How long the "Confirm" prompt stays armed before falling back to "Undo".
const CONFIRM_TIMEOUT_MS = 4000;

export function SelfModUndoButton({
  selfModApplied,
}: {
  selfModApplied: SelfModApplied;
}) {
  const [state, setState] = useState<ButtonState>(() =>
    (selfModApplied.status ?? "applied") === "pending" ? "pending" : "idle",
  );

  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

  useEffect(() => {
    setState((current) => {
      if (
        current === "applying" ||
        current === "confirming" ||
        current === "reverting" ||
        current === "reverted"
      ) {
        return current;
      }
      return (selfModApplied.status ?? "applied") === "pending"
        ? "pending"
        : "idle";
    });
  }, [selfModApplied.commitHash, selfModApplied.status]);

  const handleApply = useCallback(async () => {
    if (state !== "pending") return;
    setState("applying");
    try {
      await window.electronAPI?.agent.selfModApply(selfModApplied.commitHash);
      setState("idle");
    } catch (err) {
      console.error("Self-mod apply failed:", err);
      showToast({ title: "Failed to update Stella", variant: "error" });
      setState("pending");
    }
  }, [selfModApplied.commitHash, state]);

  const handleUndo = useCallback(async () => {
    // First click arms the confirmation; auto-disarms after a few seconds.
    if (state === "idle") {
      setState("confirming");
      clearConfirmTimer();
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null;
        setState((current) => (current === "confirming" ? "idle" : current));
      }, CONFIRM_TIMEOUT_MS);
      return;
    }
    if (state !== "confirming") return;
    // Second click confirms the revert.
    clearConfirmTimer();
    setState("reverting");
    try {
      await window.electronAPI?.agent.selfModRevert(selfModApplied.commitHash, 1);
      setState("reverted");
    } catch (err) {
      console.error("Self-mod revert failed:", err);
      showToast({ title: "Failed to undo changes", variant: "error" });
      setState("idle");
    }
  }, [selfModApplied.commitHash, state, clearConfirmTimer]);

  const label =
    state === "pending"
      ? "Stella has an update ready"
      : state === "applying"
        ? "Updating Stella…"
        : state === "confirming"
          ? "Undo this update?"
          : state === "reverting"
            ? "Undoing update…"
            : state === "reverted"
              ? "Update undone"
              : "Stella was updated";

  return (
    <div className="selfmod-card" data-state={state}>
      <span className="selfmod-card__icon">
        <StellaLogoIcon size={20} />
      </span>
      <span className="selfmod-card__label">{label}</span>
      {state === "pending" ? (
        <button
          type="button"
          className="selfmod-card__action"
          onClick={handleApply}
        >
          Update
        </button>
      ) : state === "idle" || state === "confirming" ? (
        <button
          type="button"
          className={`selfmod-card__action${
            state === "confirming" ? " selfmod-card__action--confirm" : ""
          }`}
          onClick={handleUndo}
        >
          {state === "confirming" ? "Confirm" : "Undo"}
        </button>
      ) : state === "applying" || state === "reverting" ? (
        <button type="button" className="selfmod-card__action" disabled>
          <span className="selfmod-card__spinner" />
        </button>
      ) : null}
    </div>
  );
}
