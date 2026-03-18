import { describe, test, expect } from "bun:test";
import { rateLimitResponse } from "../convex/http_shared/webhook_controls";

describe("rateLimitResponse", () => {
  test("returns 429 status", () => {
    const response = rateLimitResponse(60_000);
    expect(response.status).toBe(429);
  });

  test("sets Retry-After header in seconds", () => {
    const response = rateLimitResponse(60_000);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  test("rounds up Retry-After", () => {
    const response = rateLimitResponse(1_500);
    expect(response.headers.get("Retry-After")).toBe("2");
  });

  test("has minimum Retry-After of 1", () => {
    const response = rateLimitResponse(100);
    expect(response.headers.get("Retry-After")).toBe("1");
    const response2 = rateLimitResponse(0);
    expect(response2.headers.get("Retry-After")).toBe("1");
  });

  test("returns JSON error body", async () => {
    const response = rateLimitResponse(5_000);
    const body = await response.json();
    expect(body.error).toBe("Rate limit exceeded");
  });

  test("sets Content-Type header", () => {
    const response = rateLimitResponse(1_000);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});
