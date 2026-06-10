/**
 * Shapeshift phase — the self-modification lesson, taught by doing.
 *
 * Users reported not understanding that Stella rewrites its own app.
 * Telling them again wasn't going to fix that, so this phase puts a
 * faithful mock of the real window on stage and lets the user run the
 * loop themselves: pick a request → watch it type and send → watch
 * "Rewriting the app…" produce a file-change receipt → watch the
 * window visibly morph (tabs appear, the theme shifts, a feature grows
 * in) → press Undo and watch it revert. Receipts accumulate across
 * requests so the stage reads as a running history of self-edits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code, RotateCcw } from "@/ui/icons";
import {
  DEMO_DEFAULT_SIDEBAR,
  DemoBubble,
  DemoChat,
  DemoComposer,
  DemoShell,
  DemoWorking,
  type DemoSidebarItem,
} from "./demo/DemoShell";
import { useChoreography, useTypedText } from "./demo/use-choreography";
import "./OnboardingShapeshiftPhase.css";

type ShapeshiftPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type MorphId = "tabs" | "dusk" | "timer";

type Morph = {
  id: MorphId;
  /** The imperative request the user "sends". */
  prompt: string;
  filesChanged: number;
  /** Assistant line once the morph settles. */
  reply: string;
};

const MORPHS: Morph[] = [
  {
    id: "tabs",
    prompt: "Give me tabs",
    filesChanged: 3,
    reply: "Tabs are in, up top. Undo anytime.",
  },
  {
    id: "dusk",
    prompt: "Make it feel like dusk",
    filesChanged: 2,
    reply: "Recolored the whole app. Like it?",
  },
  {
    id: "timer",
    prompt: "Add a focus timer to my home",
    filesChanged: 4,
    reply: "Built a 25-minute focus timer onto home.",
  },
];

const TYPE_CHAR_MS = 24;

type RunEntry = {
  morph: Morph;
  undone: boolean;
};

function FocusTimerCard() {
  return (
    <div className="oshape-timer-card">
      <span className="oshape-timer-card__time">25:00</span>
      <span className="oshape-timer-card__label">Focus</span>
      <span className="oshape-timer-card__start">Start</span>
    </div>
  );
}

function Receipt({
  morph,
  undone,
  live,
  onUndo,
}: {
  morph: Morph;
  undone?: boolean;
  live?: boolean;
  onUndo?: () => void;
}) {
  return (
    <div
      className="oshape-receipt"
      data-undone={undone || undefined}
      data-live={live || undefined}
    >
      <span className="oshape-receipt__icon">
        <Code size={12} />
      </span>
      <span className="oshape-receipt__text">
        <span className="oshape-receipt__title">“{morph.prompt}”</span>
        <span className="oshape-receipt__meta">
          {undone ? "Undone" : `${morph.filesChanged} files rewritten`}
        </span>
      </span>
      {onUndo ? (
        <button type="button" className="oshape-receipt__undo" onClick={onUndo}>
          <RotateCcw size={10} />
          Undo
        </button>
      ) : null}
    </div>
  );
}

export function OnboardingShapeshiftPhase({
  splitTransitionActive,
  onContinue,
}: ShapeshiftPhaseProps) {
  const [activeMorph, setActiveMorph] = useState<Morph | null>(null);
  const [log, setLog] = useState<RunEntry[]>([]);
  const [justUndid, setJustUndid] = useState(false);
  const [undoFlashKey, setUndoFlashKey] = useState(0);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    },
    [],
  );

  const typeDurationMs = activeMorph
    ? activeMorph.prompt.length * TYPE_CHAR_MS + 320
    : 0;

  const cues = useMemo(() => {
    if (!activeMorph) return [];
    const send = typeDurationMs + 260;
    return [
      { id: "send", at: send },
      { id: "working", at: send + 380 },
      { id: "receipt", at: send + 1850 },
      { id: "morph", at: send + 2350 },
      { id: "settled", at: send + 3000 },
      // Hold the settled reply on screen before committing the run to
      // the log (the log re-renders the same rows, so the swap is
      // seamless — see the transcript section below).
      { id: "end", at: send + 4300 },
    ];
  }, [activeMorph, typeDurationMs]);

  const finishRun = useCallback(() => {
    if (!activeMorph) return;
    const finished = activeMorph;
    setLog((entries) => [...entries, { morph: finished, undone: false }]);
    setActiveMorph(null);
  }, [activeMorph]);

  const { has } = useChoreography({
    cues,
    active: activeMorph !== null,
    onDone: finishRun,
  });

  const typed = useTypedText(activeMorph?.prompt ?? "", activeMorph !== null, {
    startDelay: 280,
    charMs: TYPE_CHAR_MS,
  });

  const appliedIds = useMemo(() => {
    const ids = new Set<MorphId>(
      log.filter((entry) => !entry.undone).map((entry) => entry.morph.id),
    );
    // The shell morphs at the `morph` cue, before the run is committed
    // to the log, so mid-run application is derived here.
    if (activeMorph && has("morph")) ids.add(activeMorph.id);
    return ids;
  }, [activeMorph, has, log]);

  const startMorph = useCallback(
    (morph: Morph) => {
      if (activeMorph) return;
      setJustUndid(false);
      setActiveMorph(morph);
    },
    [activeMorph],
  );

  const handleUndo = useCallback(() => {
    if (activeMorph || undoTimerRef.current) return;
    setUndoFlashKey((key) => key + 1);
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      setLog((entries) => {
        const lastApplied = [...entries]
          .reverse()
          .find((entry) => !entry.undone);
        if (!lastApplied) return entries;
        return entries.map((entry) =>
          entry === lastApplied ? { ...entry, undone: true } : entry,
        );
      });
      setJustUndid(true);
    }, 420);
  }, [activeMorph]);

  const sidebarItems = useMemo<DemoSidebarItem[]>(() => {
    if (!appliedIds.has("timer")) return DEMO_DEFAULT_SIDEBAR;
    return [
      ...DEMO_DEFAULT_SIDEBAR,
      { id: "focus", label: "Focus", fresh: true },
    ];
  }, [appliedIds]);

  const completedRuns = log.filter((entry) => !entry.undone).length;
  const hasEverRun = log.length > 0 || activeMorph !== null;
  const remainingMorphs = MORPHS.filter(
    (morph) =>
      morph.id !== activeMorph?.id &&
      !log.some((entry) => entry.morph.id === morph.id && !entry.undone),
  );
  const lastEntry = log.length > 0 ? log[log.length - 1] : null;

  const caption = !hasEverRun
    ? "Every screen, theme, and feature here is live code that Stella can rewrite while the app runs. Pick a request and watch."
    : justUndid
      ? "Reverted. Every change keeps a one-click undo, so nothing is ever permanent."
      : completedRuns >= 2
        ? "Changes you love can be published to the Store, and anything other people built installs the same way."
        : "That was real code changing while the app stayed running. Press Undo on the receipt to take it back.";

  return (
    <div className="onboarding-step-content oshape-step">
      <div
        className="oshape-stage"
        data-dusk={appliedIds.has("dusk") || undefined}
      >
        <DemoShell
          className="oshape-shell"
          sidebarItems={sidebarItems}
          tabs={appliedIds.has("tabs") ? ["Home", "Chats", "Notes"] : undefined}
          activeTab="Home"
        >
          <DemoChat>
            <DemoBubble role="assistant" visible={!hasEverRun}>
              This is the actual app. Ask for a change and watch it rebuild
              itself.
            </DemoBubble>

            {/* Transcript: receipts persist across runs as a running
             * history of self-edits; only the newest entry keeps its
             * full conversation (user bubble + reply), older entries
             * collapse to receipt-only. */}
            {log.map((entry, index) => {
              const isLast = entry === lastEntry && !activeMorph;
              const showFull = isLast && !entry.undone;
              return (
                <div key={`${entry.morph.id}-${index}`} className="oshape-run">
                  {showFull ? (
                    <DemoBubble role="user" visible>
                      {entry.morph.prompt}
                    </DemoBubble>
                  ) : null}
                  <Receipt
                    morph={entry.morph}
                    undone={entry.undone}
                    onUndo={
                      isLast && !entry.undone && !splitTransitionActive
                        ? handleUndo
                        : undefined
                    }
                  />
                  {/* The built artifact lives at its chronological spot in
                   * the transcript so appearing never shifts rows above it
                   * (the composer below is bottom-pinned). */}
                  {entry.morph.id === "timer" && !entry.undone ? (
                    <FocusTimerCard />
                  ) : null}
                  {showFull ? (
                    <DemoBubble role="assistant" visible>
                      {entry.morph.reply}
                    </DemoBubble>
                  ) : null}
                </div>
              );
            })}

            {activeMorph ? (
              <div className="oshape-run">
                <DemoBubble role="user" visible={has("send")}>
                  {activeMorph.prompt}
                </DemoBubble>
                <DemoWorking
                  visible={has("working") && !has("receipt")}
                  label="Rewriting the app…"
                />
                {has("receipt") ? <Receipt morph={activeMorph} live /> : null}
                {activeMorph.id === "timer" && has("morph") ? (
                  <FocusTimerCard />
                ) : null}
                <DemoBubble role="assistant" visible={has("settled")}>
                  {activeMorph.reply}
                </DemoBubble>
              </div>
            ) : null}

            {justUndid && !activeMorph ? (
              <DemoBubble role="assistant" visible>
                Reverted. Ask again whenever.
              </DemoBubble>
            ) : null}

            {remainingMorphs.length > 0 ? (
              <div
                className="oshape-chips"
                data-locked={activeMorph !== null || undefined}
              >
                {remainingMorphs.map((morph) => (
                  <button
                    key={morph.id}
                    type="button"
                    className="oshape-chip"
                    disabled={activeMorph !== null || splitTransitionActive}
                    onClick={() => startMorph(morph)}
                  >
                    {morph.prompt}
                  </button>
                ))}
              </div>
            ) : null}

            <DemoComposer
              value={activeMorph && !has("send") ? typed.value : ""}
              typing={typed.typing && !has("send")}
              sending={Boolean(activeMorph && has("send") && !has("settled"))}
              placeholder="Ask for any change..."
            />
          </DemoChat>
        </DemoShell>

        {/* Morph flash — the mock's stand-in for the real capture →
         * cross-fade transition that covers live self-edits. */}
        {activeMorph && has("morph") ? (
          <div className="oshape-flash" key={`run-${activeMorph.id}`} />
        ) : null}
        {undoFlashKey > 0 ? (
          <div className="oshape-flash" key={`undo-${undoFlashKey}`} />
        ) : null}
      </div>

      <div className="oshape-caption-slot" aria-live="polite">
        <p className="oshape-caption" key={caption}>
          {caption}
        </p>
      </div>

      <button
        className="onboarding-confirm oshape-continue"
        data-visible={true}
        data-emphasized={completedRuns > 0 || undefined}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
