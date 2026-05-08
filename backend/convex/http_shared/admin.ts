const ADMIN_API_SECRET_ENV = "STELLA_ADMIN_API_SECRET";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const getBearerToken = (request: Request): string => {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

export type AdminRequestResult =
  | { ok: true }
  | { ok: false; response: Response };

export const requireAdminRequest = (request: Request): AdminRequestResult => {
  const expected = process.env[ADMIN_API_SECRET_ENV]?.trim() ?? "";
  if (!expected) {
    return {
      ok: false,
      response: jsonResponse(503, {
        error: "Admin API disabled.",
        env: ADMIN_API_SECRET_ENV,
      }),
    };
  }

  const provided = getBearerToken(request);
  if (provided !== expected) {
    return {
      ok: false,
      response: jsonResponse(401, { error: "Invalid admin credentials." }),
    };
  }

  return { ok: true };
};
