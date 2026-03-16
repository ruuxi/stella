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

export type MediaGenerateRequestBody = {
  capability?: unknown;
  profile?: unknown;
  prompt?: unknown;
  sourceUrl?: unknown;
  source?: unknown;
  input?: unknown;
  webhookUrl?: unknown;
};

export type MediaBase64Source = {
  base64: string;
  mimeType: string;
  fileName?: string;
};

export type MediaSourceReference = string | MediaBase64Source;

export type MediaGenerateRequest = {
  capability: string;
  profile?: string;
  prompt?: string;
  sourceUrl?: string;
  source?: MediaSourceReference;
  sources?: Record<string, MediaSourceReference>;
  input: Record<string, unknown>;
  webhookUrl?: string;
};

export type MediaGenerateAcceptedResponse = {
  jobId: string;
  capability: string;
  profile: string;
  status: MediaJobStatus;
  upstreamStatus: string;
  pollUrl: string;
};

export type MediaJobResponse = {
  jobId: string;
  capability: string;
  profile: string;
  status: MediaJobStatus;
  upstreamStatus: string;
  queuePosition: number | null;
  logs?: unknown[];
  output?: unknown;
  error?: MediaJobError;
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
      code,
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
  const sourceUrl = asTrimmedString(value.sourceUrl) ?? undefined;
  const webhookUrl = asTrimmedString(value.webhookUrl) ?? undefined;
  const input = isRecord(value.input) ? { ...value.input } : {};
  const sourceRecord = isRecord(value.source) ? value.source : null;
  const sourceString = asTrimmedString(value.source);
  const sourceBase64 = sourceRecord
    ? asTrimmedString(sourceRecord.base64)
    : null;
  const sourceMimeType = sourceRecord
    ? asTrimmedString(sourceRecord.mimeType)
    : null;
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
  const source = sourceString ?? sourceFromObject;

  const sourcesRecord = isRecord(value.sources) ? value.sources : null;
  const sources = sourcesRecord
    ? Object.fromEntries(
        Object.entries(sourcesRecord)
          .map(([key, entryValue]) => {
            const normalizedKey = asTrimmedString(key);
            const entryString = asTrimmedString(entryValue);
            const entryRecord = isRecord(entryValue) ? entryValue : null;
            const entryBase64 = entryRecord
              ? asTrimmedString(entryRecord.base64)
              : null;
            const entryMimeType = entryRecord
              ? asTrimmedString(entryRecord.mimeType)
              : null;
            const entryFileName = entryRecord
              ? asTrimmedString(entryRecord.fileName) ?? undefined
              : undefined;
            const entryObject =
              entryRecord &&
              (entryBase64 !== null ||
                entryMimeType !== null ||
                entryFileName !== undefined)
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
    profile,
    prompt,
    sourceUrl,
    ...(source ? { source } : {}),
    ...(sources && Object.keys(sources).length > 0 ? { sources } : {}),
    input,
    webhookUrl,
  };
};

export const createMediaGenerateRequestExample = (
  args: MediaGenerateRequest,
): MediaGenerateRequest => ({
  capability: args.capability,
  ...(args.profile ? { profile: args.profile } : {}),
  ...(args.prompt ? { prompt: args.prompt } : {}),
  ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
  ...(args.source
    ? {
        source:
          typeof args.source === "string"
            ? args.source
            : {
                base64: args.source.base64,
                mimeType: args.source.mimeType,
                ...(args.source.fileName ? { fileName: args.source.fileName } : {}),
              },
      }
    : {}),
  ...(args.sources
    ? {
        sources: Object.fromEntries(
          Object.entries(args.sources).map(([key, value]) => [
            key,
            typeof value === "string"
              ? value
              : {
                  base64: value.base64,
                  mimeType: value.mimeType,
                  ...(value.fileName ? { fileName: value.fileName } : {}),
                },
          ]),
        ),
      }
    : {}),
  input: { ...args.input },
  ...(args.webhookUrl ? { webhookUrl: args.webhookUrl } : {}),
});

export const createMediaGenerateAcceptedResponse = (
  args: MediaGenerateAcceptedResponse,
): MediaGenerateAcceptedResponse => ({
  jobId: args.jobId,
  capability: args.capability,
  profile: args.profile,
  status: args.status,
  upstreamStatus: args.upstreamStatus,
  pollUrl: args.pollUrl,
});

export const createMediaJobResponse = (
  args: MediaJobResponse,
): MediaJobResponse => ({
  jobId: args.jobId,
  capability: args.capability,
  profile: args.profile,
  status: args.status,
  upstreamStatus: args.upstreamStatus,
  queuePosition: args.queuePosition,
  ...(args.logs ? { logs: args.logs } : {}),
  ...(args.output !== undefined ? { output: args.output } : {}),
  ...(args.error ? { error: args.error } : {}),
});
