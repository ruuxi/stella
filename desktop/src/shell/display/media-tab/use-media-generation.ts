/**
 * Submit a media generation job through the Stella `/api/media/v1/generate`
 * service endpoint, plus a small hook that wraps the surrounding
 * "submitting / error" UI state.
 *
 * The plain `submitMediaJob` function is exported for callers that
 * own their own form state (e.g. `MediaStudio`, which has a much
 * larger capability catalog and wants direct control).
 */
import { useCallback, useState } from "react";
import { createServiceRequest } from "@/infra/http/service-request";
import {
  notifyMediaGenerationError,
  parseMediaApiErrorMessage,
} from "@/shared/billing/paid-media-tier-toast";
import type { MediaActionId } from "./media-actions";

export type SubmitMediaJobArgs = {
  capability: MediaActionId | string;
  prompt: string;
  source?: string;
  /** Optional input bag forwarded verbatim. Defaults to a small
   *  per-capability default (e.g. `duration_seconds` for sfx). */
  input?: Record<string, unknown>;
};

const defaultInputForCapability = (
  capability: SubmitMediaJobArgs["capability"],
): Record<string, unknown> =>
  capability === "sound_effects" ? { duration_seconds: 5 } : {};

export const submitMediaJob = async (
  args: SubmitMediaJobArgs,
): Promise<void> => {
  const { endpoint, headers } = await createServiceRequest(
    "/api/media/v1/generate",
    {
      "Content-Type": "application/json",
    },
  );
  const input = args.input ?? defaultInputForCapability(args.capability);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      capability: args.capability,
      prompt: args.prompt,
      input,
      ...(args.source ? { source: args.source } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message =
      parseMediaApiErrorMessage(text) ||
      `Media request failed (${response.status})`;
    const error = new Error(message);
    notifyMediaGenerationError(error);
    throw error;
  }
};

/**
 * Hook for surfaces (currently just the Media tab) that need to
 * track "submitting" around `submitMediaJob`. Errors toast only —
 * never inline text. `MediaStudio` doesn't use this; it owns its
 * own job-id-driven subscription state instead.
 */
export function useMediaGeneration() {
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async (args: SubmitMediaJobArgs) => {
    setSubmitting(true);
    try {
      await submitMediaJob(args);
    } finally {
      setSubmitting(false);
    }
  }, []);

  return { submitting, submit };
}
