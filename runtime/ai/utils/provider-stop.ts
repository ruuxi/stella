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
 * Message for a stream the provider deliberately terminated with an
 * anomalous stop reason instead of a completed message.
 */
export function providerAbortedStopMessage(rawStopReason: string): string {
	return (
		`Provider aborted the response (stop reason: "${rawStopReason}"). ` +
		"This is typically a provider-side refusal/safety/content-filter stop triggered by something in the request content."
	);
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
