export const REMOTE_TURN_AUTH_GRACE_MS = 15_000;
export const REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS = 2;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

export const getConvexErrorCode = (error: unknown): string | null => {
  const directCode = asRecord(error)?.code;
  if (typeof directCode === "string" && directCode.trim()) {
    return directCode.trim();
  }

  const dataCode = asRecord(asRecord(error)?.data)?.code;
  if (typeof dataCode === "string" && dataCode.trim()) {
    return dataCode.trim();
  }

  return null;
};

export const isConvexUnauthenticatedError = (error: unknown): boolean =>
  getConvexErrorCode(error) === "UNAUTHENTICATED";

export const shouldStopRemoteTurnForAuthFailure = (args: {
  authWindowStartedAt: number;
  failureCount: number;
  nowMs: number;
}): boolean => {
  const withinGraceWindow =
    args.authWindowStartedAt > 0 &&
    args.nowMs - args.authWindowStartedAt <= REMOTE_TURN_AUTH_GRACE_MS;

  return !(
    withinGraceWindow &&
    args.failureCount <= REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS
  );
};
