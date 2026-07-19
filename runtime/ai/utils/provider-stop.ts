/**
 * Honest errors for provider-terminated streams.
 *
 * Several streaming adapters historically collapsed any anomalous terminal
 * stop (refusal / safety / content-filter style stops mapped to
 * `stopReason: "error"`) into an opaque `new Error("An unknown error
 * occurred")`. That swallowed the only signal explaining why a run died and
 * made deterministic content-triggered aborts undiagnosable downstream.
 *
 * Providers should:
 * 1. call {@link providerAbortedStopMessage} at the point where a raw
 *    provider stop/finish reason maps to `"error"`, storing it on
 *    `output.errorMessage` (without clobbering an existing, more specific
 *    detail), and
 * 2. throw {@link anomalousStreamStopError} instead of a generic error when
 *    the stream ends in an `error`/`aborted` state without an exception.
 *
 * These messages intentionally carry the raw provider stop reason (never
 * credentials) so it survives into run events, task-failure payloads, and
 * logs.
 */

/**
 * Raw provider stop/finish reasons that signal a content/safety abort
 * (as opposed to generic terminal failures like `failed`, `cancelled`,
 * `OTHER`, or `network_error`). Spans the adapters that surface raw stop
 * reasons: Anthropic (`refusal`/`sensitive`), Google
 * (`SAFETY`/`PROHIBITED_CONTENT`/…), OpenAI-compatible (`content_filter`),
 * and Bedrock (`guardrail_intervened`/`content_filtered`).
 */
const SAFETY_STOP_REASONS = new Set([
	"refusal",
	"sensitive",
	"safety",
	"image_safety",
	"prohibited_content",
	"image_prohibited_content",
	"blocklist",
	"spii",
	"recitation",
	"image_recitation",
	"content_filter",
	"content_filtered",
	"guardrail_intervened",
]);

/** True when the raw stop reason is a refusal/safety/content-filter stop. */
export function isSafetyStopReason(rawStopReason: string): boolean {
	return SAFETY_STOP_REASONS.has(rawStopReason.trim().toLowerCase());
}

/**
 * Message for a stream the provider deliberately terminated with an
 * anomalous stop reason instead of a completed message.
 *
 * Safety-class stop reasons get the refusal/safety wording that downstream
 * containment (`isProviderContentAbortMessage`) classifies on; everything
 * else (`failed`, `cancelled`, `OTHER`, …) gets neutral wording so generic
 * terminal failures are never mistaken for content aborts.
 */
export function providerAbortedStopMessage(rawStopReason: string): string {
	if (isSafetyStopReason(rawStopReason)) {
		return (
			`Provider aborted the response (stop reason: "${rawStopReason}"). ` +
			"This is a provider-side refusal/safety/content-filter stop triggered by something in the request content."
		);
	}
	return `Provider ended the stream abnormally (stop reason: "${rawStopReason}") without a completed response.`;
}

/**
 * Message for an Anthropic `pause_turn` stop the adapter could not resume
 * in place. `pause_turn` is a legitimate terminal reason for long-running
 * server-tool turns whose documented remedy is resubmission, so the wording
 * is recognized as retryable by the agent-run retry ladder (a fresh attempt
 * IS a resubmission of the request) and must never read as a content abort.
 */
export function pausedTurnStopMessage(): string {
	return (
		'Provider paused the turn (stop reason: "pause_turn") before the response completed. ' +
		"Resubmitting the request continues the turn."
	);
}

/**
 * Message for a prompt the provider refused to process at all (Google
 * `promptFeedback.blockReason`). Distinct from a mid-stream safety stop:
 * no candidate was ever generated. Deterministically re-triggered by the
 * same request content, so downstream content-abort containment
 * (`isProviderContentAbortMessage`) classifies on this wording.
 */
export function promptBlockedStopMessage(blockReason: string, blockReasonMessage?: string): string {
	const detail = blockReasonMessage?.trim();
	return (
		`Provider blocked the prompt (block reason: "${blockReason}")${detail ? `: ${detail}` : ""}. ` +
		"This is a provider-side content block triggered by something in the request content."
	);
}

/**
 * Fingerprints of stream-anomaly errors that are presumptively transient:
 * - the {@link anomalousStreamStopError} no-detail fallback (premature EOF —
 *   load-balancer idle-close, proxy drop — before any terminal event),
 * - the neutral non-safety {@link providerAbortedStopMessage} wording
 *   (`failed`/`cancelled`/`OTHER`/unknown-future stop reasons on an
 *   otherwise fully-streamed message),
 * - the {@link pausedTurnStopMessage} wording (documented remedy is
 *   resubmission),
 * - the Anthropic adapter's explicit premature-EOF guard ("stream ended
 *   before message_stop").
 *
 * Deliberately excludes the safety wording of `providerAbortedStopMessage`
 * and {@link promptBlockedStopMessage}: those are deterministic content
 * aborts owned by provider-abort containment, and retrying them at the
 * transport ladder would just replay the poisoned request. The agent-run
 * retry ladder (agent-run-retry.ts) classifies matches as retryable
 * transport failures; keep this list in sync with the message builders
 * above.
 */
const TRANSIENT_STREAM_ANOMALY_PATTERNS: RegExp[] = [
	/\bprovider stream ended with stopreason "/i,
	/\bprovider ended the stream abnormally \(stop reason:/i,
	/\bprovider paused the turn \(stop reason: "pause_turn"\)/i,
	/\bstream ended before message_stop\b/i,
];

/**
 * True when an error message carries one of the transient stream-anomaly
 * fingerprints above and should be retried at the transport ladder.
 */
export function isTransientProviderStreamAnomalyMessage(message: string | undefined): boolean {
	const trimmed = message?.trim();
	if (!trimmed) return false;
	return TRANSIENT_STREAM_ANOMALY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Error to throw when a stream finished in an `error`/`aborted` state.
 * Prefers whatever detail the adapter captured (provider error body, raw
 * stop reason) over a generic fallback.
 */
export function anomalousStreamStopError(output: {
	stopReason: string;
	errorMessage?: string;
}): Error {
	const detail = output.errorMessage?.trim();
	if (detail) {
		return new Error(detail);
	}
	return new Error(
		`Provider stream ended with stopReason "${output.stopReason}" but the provider supplied no error detail.`,
	);
}
