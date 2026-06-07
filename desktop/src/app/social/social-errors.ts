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
    const raw = error.message;
    // ConvexError serializes as `ConvexError: {"message":"...","code":"..."}` —
    // try to pull a usable message back out before falling back.
    const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        // ignore
      }
    }
    // A thrown plain `Error` surfaces through the Convex client as a noisy
    // wrapper, e.g.:
    //   [CONVEX M(friends:sendFriendRequest)] [Request ID: …] Server Error
    //   Uncaught Error: You are already friends
    //       at handler (../convex/friends.ts:42)
    // Pull just the thrown sentence out so the user sees "You are already
    // friends" instead of the whole framed dump.
    const uncaught = raw.match(/Uncaught (?:Convex)?Error:\s*([^\n]+)/);
    if (uncaught?.[1]?.trim()) {
      return uncaught[1].trim();
    }
    // Couldn't extract anything human-readable from a Convex-framed error —
    // fall back rather than leak the raw `[CONVEX …]` / `ConvexError:` string.
    if (raw.startsWith("[CONVEX") || raw.startsWith("ConvexError:")) {
      return fallback;
    }
    return raw;
  }
  return fallback;
}
