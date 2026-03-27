type PendingRequestEntry<T> = {
	resolve: (value: T) => void;
	reject: (reason?: Error) => void;
	timeout: NodeJS.Timeout;
};

type PendingRequestCleanup = (requestId: string) => void;
type PendingRequestErrorFactory = string | Error | ((requestId: string) => Error);

function resolvePendingError(error: PendingRequestErrorFactory, requestId: string): Error {
	if (typeof error === "function") {
		return error(requestId);
	}
	if (typeof error === "string") {
		return new Error(error);
	}
	return error;
}

export class PendingRequestStore<T> {
	private readonly pending = new Map<string, PendingRequestEntry<T>>();

	set(requestId: string, entry: PendingRequestEntry<T>) {
		this.pending.set(requestId, entry);
	}

	has(requestId: string): boolean {
		return this.pending.has(requestId);
	}

	resolve(requestId: string, value: T, cleanup?: PendingRequestCleanup): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) {
			return false;
		}

		clearTimeout(entry.timeout);
		this.pending.delete(requestId);
		cleanup?.(requestId);
		entry.resolve(value);
		return true;
	}

	reject(requestId: string, error: PendingRequestErrorFactory, cleanup?: PendingRequestCleanup): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) {
			return false;
		}

		clearTimeout(entry.timeout);
		this.pending.delete(requestId);
		cleanup?.(requestId);
		entry.reject(resolvePendingError(error, requestId));
		return true;
	}

	rejectAll(error: PendingRequestErrorFactory, cleanup?: PendingRequestCleanup) {
		for (const [requestId, entry] of this.pending) {
			clearTimeout(entry.timeout);
			cleanup?.(requestId);
			entry.reject(resolvePendingError(error, requestId));
		}
		this.pending.clear();
	}
}
