import { useEffect, useRef } from "react";
import type { EventRecord } from "./lib/event-transforms";
import type { DisplayPayload } from "../../shared/contracts/display-payload";
import { markMediaJobMaterialized } from "@/app/media/use-media-materializer";

/**
 * Watches the conversation event stream for tool outputs whose result is
 * the user's *explicit goal* (generated media) and pops them open in the
 * Display sidebar automatically.
 *
 * Office previews and PDF reads are deliberately **not** auto-routed any
 * more — they get a clickable end-of-turn resource pill in the chat
 * (`EndResourceCard`) so we don't steal focus from the user mid-thread.
 * That mirrors the Codex desktop pattern where the side panel only
 * opens on explicit user action for read/edit artifacts.
 *
 * The hook fires `onPayload(payload)` exactly once per new candidate,
 * keyed on the source event id so re-renders of the same chat list
 * don't cause repeated routing.
 */
export const useDisplayAutoRoute = (
  events: EventRecord[] | undefined,
  onPayload: (payload: DisplayPayload) => void,
) => {
  const lastSourceIdRef = useRef<string | null>(null);
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  useEffect(() => {
    if (!events || events.length === 0) return;

    const candidate = findLatestDisplayCandidate(events);
    if (!candidate) return;

    if (lastSourceIdRef.current === candidate.sourceId) return;
    lastSourceIdRef.current = candidate.sourceId;

    if (candidate.payload.kind === "media" && candidate.payload.jobId) {
      markMediaJobMaterialized(candidate.payload.jobId);
    }

    onPayloadRef.current(candidate.payload);
  }, [events]);
};

/** Internal — exported for unit tests. */
export type DisplayCandidate = {
  sourceId: string;
  timestamp: number;
  payload: DisplayPayload;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

const imageGenResultToMediaPayload = (
  event: EventRecord,
  result: unknown,
): DisplayCandidate | null => {
  if (!isRecord(result)) return null;
  const rawPaths = result.filePaths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return null;
  const filePaths = rawPaths.filter((p): p is string => typeof p === "string");
  if (filePaths.length === 0) return null;

  const jobId = typeof result.jobId === "string" ? result.jobId : undefined;
  const capability =
    typeof result.capability === "string" ? result.capability : undefined;
  const prompt = typeof result.prompt === "string" ? result.prompt : undefined;

  return {
    sourceId: event._id,
    timestamp: event.timestamp,
    payload: {
      kind: "media",
      asset: { kind: "image", filePaths },
      createdAt: event.timestamp,
      ...(jobId ? { jobId } : {}),
      ...(capability ? { capability } : {}),
      ...(prompt ? { prompt } : {}),
    },
  };
};

/**
 * Pure routing logic for `useDisplayAutoRoute`. Exported separately so the
 * rules can be unit-tested without mounting React.
 *
 * Returns the latest auto-openable candidate (currently media-only:
 * `image_gen`). Office previews and PDF reads are not surfaced here —
 * they ride the in-chat `EndResourceCard` instead.
 */
export const findLatestDisplayCandidate = (
  events: EventRecord[],
): DisplayCandidate | null => {
  let best: DisplayCandidate | null = null;

  const consider = (next: DisplayCandidate) => {
    if (!best || next.timestamp >= best.timestamp) {
      best = next;
    }
  };

  for (const event of events) {
    if (event.type !== "tool_result") continue;

    const payload = event.payload as
      | {
          toolName?: unknown;
          error?: unknown;
          result?: unknown;
        }
      | undefined;
    if (!payload) continue;

    if (payload.toolName === "image_gen" && !payload.error) {
      const fromResult = imageGenResultToMediaPayload(event, payload.result);
      if (fromResult) {
        consider(fromResult);
      }
    }
  }

  return best;
};
