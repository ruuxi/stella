export const MEDIA_JOB_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type MediaJobStatus = (typeof MEDIA_JOB_STATUS_VALUES)[number];

export type MediaJobError = {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type MediaBase64Source = {
  base64: string;
  mimeType: string;
  fileName?: string;
};

export type MediaSourceReference = string | MediaBase64Source;

export type MediaGenerateRequestBody = {
  capability?: unknown;
  profile?: unknown;
  prompt?: unknown;
  aspectRatio?: unknown;
  sourceUrl?: unknown;
  source?: unknown;
  sources?: unknown;
  input?: unknown;
};

export type MediaGenerateRequest = {
  capability: string;
  profile?: string;
  prompt?: string;
  aspectRatio?: string;
  sourceUrl?: string;
  source?: MediaSourceReference;
  sources?: Record<string, MediaSourceReference>;
  input: Record<string, unknown>;
};

export type MediaGenerateAcceptedResponse = {
  jobId: string;
  capability: string;
  profile: string;
  status: MediaJobStatus;
  upstreamStatus: string;
  subscription: {
    query: string;
    args: Record<string, unknown>;
  };
};

export type MediaRequestSummary = {
  prompt?: string;
  aspectRatio?: string;
  source?: {
    kind: "url" | "data_uri" | "base64_object";
    mimeType?: string;
  };
  sources?: Record<
    string,
    {
      kind: "url" | "data_uri" | "base64_object";
      mimeType?: string;
    }
  >;
  input?: Record<string, unknown>;
};

export type MediaJobResponse = {
  jobId: string;
  capability: string;
  profile: string;
  request: MediaRequestSummary;
  status: MediaJobStatus;
  upstreamStatus: string;
  queuePosition: number | null;
  logs?: unknown[];
  output?: unknown;
  error?: MediaJobError;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const createMediaJobError = (args: {
  value?: unknown;
  fallbackMessage?: string;
}): MediaJobError | undefined => {
  const directMessage = asTrimmedString(args.value);
  if (directMessage) {
    return { message: directMessage };
  }

  if (isRecord(args.value)) {
    const code = asTrimmedString(args.value.code) ?? undefined;
    const message =
      asTrimmedString(args.value.message) ??
      asTrimmedString(args.value.error) ??
      args.fallbackMessage;
    if (!message) {
      return undefined;
    }

    const details = Object.fromEntries(
      Object.entries(args.value).filter(
        ([key]) => key !== "message" && key !== "error" && key !== "code",
      ),
    );

    return {
      message,
      ...(code ? { code } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  }

  if (!args.fallbackMessage) {
    return undefined;
  }

  return { message: args.fallbackMessage };
};

export const parseMediaGenerateRequest = (
  value: unknown,
): MediaGenerateRequest | null => {
  if (!isRecord(value)) {
    return null;
  }

  const capability = asTrimmedString(value.capability);
  if (!capability) {
    return null;
  }

  const profile = asTrimmedString(value.profile)?.toLowerCase();
  const prompt = asTrimmedString(value.prompt) ?? undefined;
  const aspectRatio = asTrimmedString(value.aspectRatio) ?? undefined;
  const sourceUrl = asTrimmedString(value.sourceUrl) ?? undefined;
  const input = isRecord(value.input) ? { ...value.input } : {};

  const sourceRecord = isRecord(value.source) ? value.source : null;
  const sourceString = asTrimmedString(value.source);
  const sourceBase64 = sourceRecord ? asTrimmedString(sourceRecord.base64) : null;
  const sourceMimeType = sourceRecord ? asTrimmedString(sourceRecord.mimeType) : null;
  const sourceFileName = sourceRecord
    ? asTrimmedString(sourceRecord.fileName) ?? undefined
    : undefined;
  const sourceFromObject =
    sourceRecord &&
    (sourceBase64 !== null || sourceMimeType !== null || sourceFileName !== undefined)
      ? {
          base64: sourceBase64 ?? "",
          mimeType: sourceMimeType ?? "",
          ...(sourceFileName ? { fileName: sourceFileName } : {}),
        }
      : undefined;

  const sourcesRecord = isRecord(value.sources) ? value.sources : null;
  const sources = sourcesRecord
    ? Object.fromEntries(
        Object.entries(sourcesRecord)
          .map(([key, entryValue]) => {
            const normalizedKey = asTrimmedString(key);
            const entryString = asTrimmedString(entryValue);
            const entryRecord = isRecord(entryValue) ? entryValue : null;
            const entryBase64 = entryRecord ? asTrimmedString(entryRecord.base64) : null;
            const entryMimeType = entryRecord ? asTrimmedString(entryRecord.mimeType) : null;
            const entryFileName = entryRecord
              ? asTrimmedString(entryRecord.fileName) ?? undefined
              : undefined;
            const entryObject =
              entryRecord &&
              (entryBase64 !== null || entryMimeType !== null || entryFileName !== undefined)
                ? {
                    base64: entryBase64 ?? "",
                    mimeType: entryMimeType ?? "",
                    ...(entryFileName ? { fileName: entryFileName } : {}),
                  }
                : undefined;
            const normalizedEntry = entryString ?? entryObject;
            return normalizedKey && normalizedEntry
              ? [normalizedKey, normalizedEntry]
              : null;
          })
          .filter((entry): entry is [string, MediaSourceReference] => Boolean(entry)),
      )
    : undefined;

  return {
    capability,
    ...(profile ? { profile } : {}),
    ...(prompt ? { prompt } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceString ?? sourceFromObject ? { source: sourceString ?? sourceFromObject } : {}),
    ...(sources && Object.keys(sources).length > 0 ? { sources } : {}),
    input,
  };
};

export const createMediaGenerateRequestExample = (
  args: MediaGenerateRequest,
): MediaGenerateRequest => ({
  capability: args.capability,
  ...(args.profile ? { profile: args.profile } : {}),
  ...(args.prompt ? { prompt: args.prompt } : {}),
  ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
  ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
  ...(args.source ? { source: args.source } : {}),
  ...(args.sources ? { sources: args.sources } : {}),
  input: { ...args.input },
});

export const createMediaGenerateAcceptedResponse = (
  args: MediaGenerateAcceptedResponse,
): MediaGenerateAcceptedResponse => ({
  jobId: args.jobId,
  capability: args.capability,
  profile: args.profile,
  status: args.status,
  upstreamStatus: args.upstreamStatus,
  subscription: {
    query: args.subscription.query,
    args: { ...args.subscription.args },
  },
});

export const createMediaJobResponse = (
  args: MediaJobResponse,
): MediaJobResponse => ({
  jobId: args.jobId,
  capability: args.capability,
  profile: args.profile,
  request: {
    ...(args.request.prompt ? { prompt: args.request.prompt } : {}),
    ...(args.request.aspectRatio ? { aspectRatio: args.request.aspectRatio } : {}),
    ...(args.request.source ? { source: { ...args.request.source } } : {}),
    ...(args.request.sources
      ? {
          sources: Object.fromEntries(
            Object.entries(args.request.sources).map(([key, value]) => [key, { ...value }]),
          ),
        }
      : {}),
    ...(args.request.input ? { input: { ...args.request.input } } : {}),
  },
  status: args.status,
  upstreamStatus: args.upstreamStatus,
  queuePosition: args.queuePosition,
  ...(args.logs ? { logs: args.logs } : {}),
  ...(args.output !== undefined ? { output: args.output } : {}),
  ...(args.error ? { error: args.error } : {}),
  createdAt: args.createdAt,
  updatedAt: args.updatedAt,
  ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
  ...(args.completedAt !== undefined ? { completedAt: args.completedAt } : {}),
});
