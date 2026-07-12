import { isTransientTransportError } from "./retry.js";

export type StreamReconnectPhase = "connect" | "resume" | "waiting-for-safe-resume";

export type StreamReconnectInfo = {
	attempt: number;
	delayMs: number;
	elapsedMs: number;
	phase: StreamReconnectPhase;
	reason?: string;
};

export type ResilientEventStreamOptions<T> = {
	connect: (signal?: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
	resume?: (args: { runId: string; cursor: number; signal?: AbortSignal }) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
	getInitialResumeState?: () => { runId: string; cursor: number } | undefined;
	getRunId: (event: T) => string | undefined;
	getSequence: (event: T) => number | undefined;
	isTerminal: (event: T) => boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	random?: () => number;
	now?: () => number;
	isRetryable?: (error: unknown) => boolean;
	onReconnect?: (info: StreamReconnectInfo) => void;
};

const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_JITTER_RATIO = 0.2;

class UnexpectedStreamEofError extends Error {
	constructor() {
		super("The response stream ended before a terminal event (unexpected EOF).");
		this.name = "UnexpectedStreamEofError";
	}
}

export class StreamReconnectError extends Error {
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly partialResponse: boolean;
	readonly resumable: boolean;

	constructor(args: { cause: unknown; attempts: number; elapsedMs: number; partialResponse: boolean; resumable: boolean }) {
		const reason = errorMessage(args.cause);
		const elapsed = `${(args.elapsedMs / 1_000).toFixed(1)}s`;
		const attempts = `${args.attempts} safe reconnect attempt${args.attempts === 1 ? "" : "s"}`;
		const safety =
			args.partialResponse && !args.resumable
				? " Partial response state was preserved and the request was not replayed because no durable resume cursor was available."
				: "";
		super(`Connection recovery failed after ${attempts} over ${elapsed}.${safety} Last transport error: ${reason}`);
		this.name = "StreamReconnectError";
		this.cause = args.cause;
		this.attempts = args.attempts;
		this.elapsedMs = args.elapsedMs;
		this.partialResponse = args.partialResponse;
		this.resumable = args.resumable;
	}
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message || error.name : String(error));

const abortError = (signal: AbortSignal): Error => {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" && reason.trim() ? reason : "Request was aborted");
	error.name = "AbortError";
	return error;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError(signal!));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const linkAbortSignals = (first?: AbortSignal, second?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } => {
	const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined);
	if (signals.length <= 1) {
		return { signal: signals[0], cleanup: () => {} };
	}
	const controller = new AbortController();
	const listeners = signals.map((signal) => {
		const onAbort = () => controller.abort(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		return { signal, onAbort };
	});
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, onAbort } of listeners) {
				signal.removeEventListener("abort", onAbort);
			}
		},
	};
};

const retryDelay = (args: {
	retryIndex: number;
	baseDelayMs: number;
	maxDelayMs: number;
	jitterRatio: number;
	random: () => number;
}): number => {
	const exponential = Math.min(args.baseDelayMs * 2 ** args.retryIndex, args.maxDelayMs);
	const jitter = 1 + (args.random() * 2 - 1) * args.jitterRatio;
	return Math.max(0, Math.round(exponential * jitter));
};

/**
 * Reconnect an event stream without replaying application work.
 *
	 * Before the first event, an adapter can seed a durable run id and cursor from
	 * response headers; body failure then resumes instead of replaying `connect`.
	 * Without seeded state, pre-header failures may call an idempotent `connect`
	 * again. After events arrive this helper only invokes `resume`. If no durable
	 * state exists it preserves the partial response and fails without replay.
 */
export async function* resilientEventStream<T>(options: ResilientEventStreamOptions<T>): AsyncGenerator<T, void, void> {
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;
	const isRetryable = options.isRetryable ?? isTransientTransportError;

	let reconnectStartedAt: number | undefined;
	let reconnectAttempts = 0;
	let retryIndex = 0;
	let receivedEvent = false;
	let runId: string | undefined;
	let cursor: number | undefined;
	let lastError: unknown;
	let nextConnection: "connect" | "resume" = "connect";
	let recoveryController: AbortController | undefined;
	let recoveryDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const clearRecoveryWindow = () => {
		if (recoveryDeadlineTimer) clearTimeout(recoveryDeadlineTimer);
		recoveryDeadlineTimer = undefined;
		recoveryController = undefined;
		reconnectStartedAt = undefined;
		reconnectAttempts = 0;
		retryIndex = 0;
		lastError = undefined;
	};

	try {
		for (;;) {
			if (options.signal?.aborted) throw abortError(options.signal);

			const linked = linkAbortSignals(options.signal, recoveryController?.signal);
			try {
				const source =
					nextConnection === "resume"
						? await options.resume!({
								runId: runId!,
								cursor: cursor!,
								...(linked.signal ? { signal: linked.signal } : {}),
							})
						: await options.connect(linked.signal);
				const initialResumeState =
					nextConnection === "connect" && runId === undefined && cursor === undefined
						? options.getInitialResumeState?.()
						: undefined;
				if (initialResumeState) {
					runId = initialResumeState.runId;
					cursor = initialResumeState.cursor;
				}
				let terminal = false;
				for await (const event of source) {
					if (options.signal?.aborted) throw abortError(options.signal);
					if (recoveryController?.signal.aborted) {
						throw recoveryController.signal.reason;
					}
					const sequence = options.getSequence(event);
					if (sequence !== undefined && cursor !== undefined && sequence <= cursor) {
						continue;
					}
					if (reconnectStartedAt !== undefined) clearRecoveryWindow();
					receivedEvent = true;
					runId = options.getRunId(event) ?? runId;
					if (sequence !== undefined) cursor = sequence;
					terminal = options.isTerminal(event);
					yield event;
					if (terminal) return;
				}
				if (!terminal) throw new UnexpectedStreamEofError();
				return;
			} catch (error) {
				if (options.signal?.aborted) throw abortError(options.signal);
				if (recoveryController?.signal.aborted) {
					throw new StreamReconnectError({
						cause: lastError ?? error,
						attempts: reconnectAttempts,
						elapsedMs: Math.max(0, now() - reconnectStartedAt!),
						partialResponse: receivedEvent,
						resumable: Boolean(options.resume) && Boolean(runId) && cursor !== undefined,
					});
				}
				if (!isRetryable(error)) throw error;
				lastError = error;
				if (reconnectStartedAt === undefined) {
					reconnectStartedAt = now();
					recoveryController = new AbortController();
					recoveryDeadlineTimer = setTimeout(() => {
						recoveryController?.abort(new Error("Reconnect deadline exhausted"));
					}, deadlineMs);
					recoveryDeadlineTimer.unref?.();
				}
			} finally {
				linked.cleanup();
			}

			const canResume = Boolean(options.resume) && Boolean(runId) && cursor !== undefined;
			const canReconnect = !receivedEvent || canResume;
			nextConnection = canResume ? "resume" : "connect";
			if (!canReconnect) {
				let waitIndex = retryIndex;
				for (;;) {
					const elapsedMs = Math.max(0, now() - reconnectStartedAt!);
					const remainingMs = Math.max(0, deadlineMs - elapsedMs);
					if (remainingMs <= 0) {
						throw new StreamReconnectError({
							cause: lastError,
							attempts: reconnectAttempts,
							elapsedMs,
							partialResponse: true,
							resumable: false,
						});
					}
					const delayMs = Math.min(
						retryDelay({
							retryIndex: waitIndex,
							baseDelayMs,
							maxDelayMs,
							jitterRatio,
							random,
						}),
						remainingMs,
					);
					try {
						options.onReconnect?.({
							attempt: waitIndex - retryIndex + 1,
							delayMs,
							elapsedMs,
							phase: "waiting-for-safe-resume",
							reason: errorMessage(lastError),
						});
					} catch {
						// Status reporting cannot break recovery.
					}
					await sleep(delayMs, options.signal);
					waitIndex += 1;
				}
			}

			const elapsedMs = Math.max(0, now() - reconnectStartedAt!);
			const remainingMs = Math.max(0, deadlineMs - elapsedMs);
			if (remainingMs <= 0) {
				throw new StreamReconnectError({
					cause: lastError,
					attempts: reconnectAttempts,
					elapsedMs,
					partialResponse: receivedEvent,
					resumable: canResume,
				});
			}

			const plannedDelay = retryDelay({
				retryIndex,
				baseDelayMs,
				maxDelayMs,
				jitterRatio,
				random,
			});
			const delayMs = Math.min(plannedDelay, remainingMs);
			const phase: StreamReconnectPhase = canResume ? "resume" : "connect";
			try {
				options.onReconnect?.({
					attempt: reconnectAttempts + 1,
					delayMs,
					elapsedMs,
					phase,
					reason: errorMessage(lastError),
				});
			} catch {
				// Status reporting cannot break recovery.
			}
			const linkedSleep = linkAbortSignals(options.signal, recoveryController?.signal);
			try {
				await sleep(delayMs, linkedSleep.signal);
			} catch (error) {
				if (options.signal?.aborted) throw abortError(options.signal);
				throw new StreamReconnectError({
					cause: lastError ?? error,
					attempts: reconnectAttempts,
					elapsedMs: Math.max(0, now() - reconnectStartedAt!),
					partialResponse: receivedEvent,
					resumable: canResume,
				});
			} finally {
				linkedSleep.cleanup();
			}
			retryIndex += 1;
			if (canReconnect && now() - reconnectStartedAt! < deadlineMs) {
				reconnectAttempts += 1;
				continue;
			}
			throw new StreamReconnectError({
				cause: lastError,
				attempts: reconnectAttempts,
				elapsedMs: Math.max(0, now() - reconnectStartedAt!),
				partialResponse: receivedEvent,
				resumable: canResume,
			});
		}
	} finally {
		clearRecoveryWindow();
	}
}
