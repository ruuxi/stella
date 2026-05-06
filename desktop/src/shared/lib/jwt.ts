export function parseJwtPayload<TPayload extends Record<string, unknown>>(
  token: string,
): TPayload {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Missing JWT payload");
  }
  return JSON.parse(atob(payload)) as TPayload;
}

export function getJwtExpMs(token: string): number {
  const payload = parseJwtPayload<{ exp?: unknown }>(token);
  if (typeof payload.exp !== "number") {
    throw new Error("Missing exp claim");
  }
  return payload.exp * 1000;
}
