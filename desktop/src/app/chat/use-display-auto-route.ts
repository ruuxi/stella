import { useEffect, useRef } from "react";
import type { EventRecord } from "./lib/event-transforms";
import { isOfficePreviewRef } from "../../shared/contracts/office-preview";
import type { DisplayPayload } from "../../shared/contracts/display-payload";

/**
 * Watches the conversation event stream and routes "visual" tool outputs
 * into the Display sidebar.
 *
 * Auto-routes:
 *   - Office previews (`stella-office preview`) — any `tool_result` carrying
 *     a `payload.officePreviewRef`.
 *   - PDF reads — any `tool_request` for the `Read` tool with a `.pdf` path,
 *     once its matching `tool_result` arrives without an error.
 *
 * HTML payloads from the agent's `Display` tool flow through a separate
 * channel (`window.electronAPI.display.onUpdate`) and are not handled here.
 *
 * The hook fires `onPayload(payload)` exactly once per new candidate, using
 * the source event id as a dedup key so re-renders of the same chat list
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
    onPayloadRef.current(candidate.payload);
  }, [events]);
};

/** Internal — exported for unit tests. */
export type DisplayCandidate = {
  sourceId: string;
  timestamp: number;
  payload: DisplayPayload;
};

const PDF_PATH_PATTERN = /\.pdf(?:[?#].*)?$/i;

/**
 * Pure routing logic for `useDisplayAutoRoute`. Exported separately so the
 * rules can be unit-tested without mounting React.
 */
export const findLatestDisplayCandidate = (
  events: EventRecord[],
): DisplayCandidate | null => {
  // Build a quick map of pending Read requests so we can pair them up with
  // their tool_result event.
  const pendingPdfReads = new Map<string, { path: string; timestamp: number }>();
  let best: DisplayCandidate | null = null;

  const consider = (next: DisplayCandidate) => {
    if (!best || next.timestamp >= best.timestamp) {
      best = next;
    }
  };

  for (const event of events) {
    if (event.type === "tool_request") {
      const payload = event.payload as
        | { toolName?: unknown; args?: Record<string, unknown> }
        | undefined;
      if (
        payload &&
        typeof payload.toolName === "string" &&
        payload.toolName === "Read"
      ) {
        const argPath = payload.args?.path;
        if (typeof argPath === "string" && PDF_PATH_PATTERN.test(argPath)) {
          const requestId =
            (event.requestId && event.requestId.trim()) || event._id;
          pendingPdfReads.set(requestId, {
            path: argPath,
            timestamp: event.timestamp,
          });
        }
      }
      continue;
    }

    if (event.type !== "tool_result") continue;

    const payload = event.payload as
      | {
          toolName?: unknown;
          officePreviewRef?: unknown;
          error?: unknown;
        }
      | undefined;
    if (!payload) continue;

    if (isOfficePreviewRef(payload.officePreviewRef)) {
      consider({
        sourceId: event._id,
        timestamp: event.timestamp,
        payload: {
          kind: "office",
          previewRef: payload.officePreviewRef,
        },
      });
      continue;
    }

    const requestId =
      (event.requestId && event.requestId.trim()) || event._id;
    const pending = pendingPdfReads.get(requestId);
    if (pending && !payload.error) {
      consider({
        sourceId: event._id,
        timestamp: event.timestamp,
        payload: {
          kind: "pdf",
          filePath: pending.path,
        },
      });
      pendingPdfReads.delete(requestId);
    }
  }

  return best;
};
