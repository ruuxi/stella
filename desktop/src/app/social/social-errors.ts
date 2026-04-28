type ConvexErrorPayload = { message?: unknown; code?: unknown };

function readErrorData(error: unknown): ConvexErrorPayload | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data === "object" && data !== null) {
    return data as ConvexErrorPayload;
  }
  return null;
}

export function getSocialActionErrorMessage(
  fallback: string,
  error: unknown,
): string {
  const data = readErrorData(error);
  if (data && typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }
  if (error instanceof Error && error.message) {
    // ConvexError serializes as `ConvexError: {"message":"...","code":"..."}` —
    // try to pull a usable message back out before falling back.
    const match = error.message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        // ignore
      }
    }
    if (!error.message.startsWith("ConvexError:")) {
      return error.message;
    }
  }
  return fallback;
}
