import { describe, test, expect } from "bun:test";
import {
  getCorsHeaders,
  withCors,
  rejectDisallowedCorsOrigin,
  preflightCorsResponse,
  jsonResponse,
  errorResponse,
} from "../convex/http_shared/cors";

const makeRequest = (origin: string | null): Request => {
  const headers = new Headers();
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request("https://example.com", { headers });
};

describe("getCorsHeaders", () => {
  test("includes standard CORS headers", () => {
    const headers = getCorsHeaders(null);
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("sets Allow-Origin for allowed origins", () => {
    const headers = getCorsHeaders("http://localhost:5714");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5714");
  });

  test("sets Allow-Origin for any localhost port", () => {
    const headers = getCorsHeaders("http://localhost:3000");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  test("omits Allow-Origin for disallowed origins", () => {
    const headers = getCorsHeaders("https://evil.com");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("handles null origin", () => {
    const headers = getCorsHeaders(null);
    // null origin is allowed, but no origin to set
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("withCors", () => {
  test("adds CORS headers to response", () => {
    const base = new Response("ok", { status: 200 });
    const result = withCors(base, "http://localhost:5714");
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5714");
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(result.status).toBe(200);
  });

  test("preserves original response body and status", async () => {
    const base = new Response("body content", { status: 201 });
    const result = withCors(base, null);
    expect(result.status).toBe(201);
    expect(await result.text()).toBe("body content");
  });
});

describe("rejectDisallowedCorsOrigin", () => {
  test("returns null for allowed origins", () => {
    expect(rejectDisallowedCorsOrigin(makeRequest("http://localhost:5714"))).toBeNull();
    expect(rejectDisallowedCorsOrigin(makeRequest("http://localhost:3000"))).toBeNull();
  });

  test("returns null when no origin", () => {
    expect(rejectDisallowedCorsOrigin(makeRequest(null))).toBeNull();
  });

  test("returns 403 for disallowed origins", () => {
    const result = rejectDisallowedCorsOrigin(makeRequest("https://evil.com"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

describe("preflightCorsResponse", () => {
  test("returns 204 with CORS headers", () => {
    const result = preflightCorsResponse(makeRequest("http://localhost:5714"));
    expect(result.status).toBe(204);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5714");
  });
});

describe("jsonResponse", () => {
  test("returns JSON body with correct content type", async () => {
    const result = jsonResponse({ key: "value" });
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toBe("application/json");
    const body = await result.json();
    expect(body.key).toBe("value");
  });

  test("uses specified status code", () => {
    const result = jsonResponse({ error: "not found" }, 404);
    expect(result.status).toBe(404);
  });

  test("adds CORS headers when origin provided", () => {
    const result = jsonResponse({ ok: true }, 200, "http://localhost:5714");
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5714");
  });

  test("omits CORS headers when origin is undefined", () => {
    const result = jsonResponse({ ok: true }, 200);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("errorResponse", () => {
  test("returns JSON error body", async () => {
    const result = errorResponse(400, "Bad request");
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body.error).toBe("Bad request");
  });

  test("adds CORS headers when origin provided", () => {
    const result = errorResponse(500, "Internal error", "http://localhost:5714");
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5714");
  });
});
