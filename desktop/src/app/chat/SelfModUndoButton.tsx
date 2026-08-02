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

const getCompleteCommitSet = (
  commitHashes: string[] | undefined,
): string[] | null => {
  if (!commitHashes || commitHashes.length === 0) return null;
  const normalized = commitHashes.map((hash) => hash.trim());
  if (
    normalized.some((hash) => hash.length === 0) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
};

export function SelfModUndoButton({
  selfModApplied,
}: {
  selfModApplied: SelfModApplied;
}) {
  const [state, setState] = useState<ButtonState>(() => {
    const status = selfModApplied.status ?? "applied";
    return status === "pending"
      ? "pending"
      : status === "reverted"
        ? "reverted"
        : "idle";
  });

  // New cards expose the complete grouped target through `commitHashes`.
  // Presence of an invalid/empty grouped field must not fall back to one
  // singular hash: that would turn an all-or-nothing Undo into a partial one.
  const groupedCommitHashes = getCompleteCommitSet(selfModApplied.commitHashes);
  const legacyCommitHash = selfModApplied.commitHash?.trim() || null;
  const hasGroupedCommitField = selfModApplied.commitHashes !== undefined;
  const canUndo = Boolean(
    groupedCommitHashes || (!hasGroupedCommitField && legacyCommitHash),
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
      const status = selfModApplied.status ?? "applied";
      return status === "pending"
        ? "pending"
        : status === "reverted"
          ? "reverted"
          : "idle";
    });
  }, [
    selfModApplied.commitHash,
    selfModApplied.commitHashes,
    selfModApplied.status,
  ]);

  const handleApply = useCallback(async () => {
    if (state !== "pending") return;
    setState("applying");
    try {
      await window.electronAPI?.agent.selfModApply(
        selfModApplied.applyId,
        selfModApplied.commitHash,
      );
      setState("idle");
    } catch (err) {
      console.error("Self-mod apply failed:", err);
      showToast({ title: "Failed to update Stella", variant: "error" });
      setState("pending");
    }
  }, [selfModApplied.applyId, selfModApplied.commitHash, state]);

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;
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
      const applyId = selfModApplied.changeSetId ?? selfModApplied.applyId;
      await window.electronAPI?.agent.selfModRevert(
        groupedCommitHashes
          ? { applyId, commitHashes: groupedCommitHashes }
          : { applyId, commitHash: legacyCommitHash ?? undefined, steps: 1 },
      );
      setState("reverted");
    } catch (err) {
      console.error("Self-mod revert failed:", err);
      showToast({ title: "Failed to undo changes", variant: "error" });
      setState("idle");
    }
  }, [
    canUndo,
    clearConfirmTimer,
    groupedCommitHashes,
    legacyCommitHash,
    selfModApplied.applyId,
    selfModApplied.changeSetId,
    state,
  ]);

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
      ) : (state === "idle" || state === "confirming") && canUndo ? (
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
