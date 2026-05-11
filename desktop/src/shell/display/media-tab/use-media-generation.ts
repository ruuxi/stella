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
import { maybeShowPaidMediaTierToast } from "@/shared/billing/paid-media-tier-toast";
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
    const message = text || `Media request failed (${response.status})`;
    const error = new Error(message);
    maybeShowPaidMediaTierToast(error);
    throw error;
  }
};

/**
 * Hook for surfaces (currently just the Media tab) that need to
 * track "submitting" + "last error" around `submitMediaJob`.
 * `MediaStudio` doesn't use this — it owns its own job-id-driven
 * subscription state instead.
 */
export function useMediaGeneration() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (args: SubmitMediaJobArgs) => {
    setSubmitting(true);
    setError(null);
    try {
      await submitMediaJob(args);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not start media work";
      setError(message);
      throw caught;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { submitting, error, setError, clearError, submit };
}
