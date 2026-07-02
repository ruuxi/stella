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
