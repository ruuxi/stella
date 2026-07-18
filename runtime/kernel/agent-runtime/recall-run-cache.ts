export type RecallLookupStatus =
  | "found"
  | "no_match"
  | "retrieval_error"
  | "synthesis_error";

export type RecallLookupResult = {
  status: RecallLookupStatus;
  brief: string;
  /** True when this normalized lookup already ran (or was already in flight). */
  cached?: true;
  intent?: string;
  fastPath?: boolean;
  sources?: Array<{
    kind: "memory" | "thread" | "transcript" | "live";
    inboxId?: number;
    threadId?: string;
    runId?: string;
  }>;
};

const normalizeLookupPart = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");

export const buildRecallLookupCacheKey = (
  prompt: string,
  memorySearchTerms: readonly string[] | undefined,
): string => {
  const terms = [...new Set((memorySearchTerms ?? []).map(normalizeLookupPart))]
    .filter(Boolean)
    .sort();
  return JSON.stringify([normalizeLookupPart(prompt), terms]);
};

/**
 * Per-run Recall memoization. Promise values collapse concurrent duplicates;
 * bounded run retention prevents abandoned run ids from growing forever.
 */
export class RecallRunCache {
  readonly #runs = new Map<string, Map<string, Promise<RecallLookupResult>>>();

  constructor(private readonly maxRuns = 64) {}

  async getOrCreate(
    runId: string,
    prompt: string,
    memorySearchTerms: readonly string[] | undefined,
    create: () => Promise<RecallLookupResult>,
  ): Promise<RecallLookupResult> {
    let entries = this.#runs.get(runId);
    if (!entries) {
      entries = new Map();
      this.#runs.set(runId, entries);
      while (this.#runs.size > this.maxRuns) {
        const oldestRunId = this.#runs.keys().next().value as
          | string
          | undefined;
        if (!oldestRunId) break;
        this.#runs.delete(oldestRunId);
      }
    }
    const key = buildRecallLookupCacheKey(prompt, memorySearchTerms);
    const existing = entries.get(key);
    if (existing) {
      return { ...(await existing), cached: true };
    }
    const pending = create();
    entries.set(key, pending);
    return await pending;
  }
}
