/**
 * Thin Convex action exposing IntegrationRequest to authenticated frontend callers.
 *
 * This allows generated canvas components to make API calls via the
 * useIntegrationRequest hook without needing a device tool round-trip.
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireUserId } from "../auth";
import { jsonValueValidator } from "../shared_validators";
import { getUnsafeIntegrationHostError } from "./network_safety";

export const execute = action({
  args: {
    provider: v.string(),
    request: v.object({
      url: v.string(),
      method: v.optional(v.string()),
      headers: v.optional(v.record(v.string(), v.string())),
      query: v.optional(v.record(v.string(), v.string())),
      body: v.optional(jsonValueValidator),
      timeoutMs: v.optional(v.number()),
    }),
    responseType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireUserId(ctx);

    const { request, responseType } = args;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { error: "Invalid URL." };
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      return { error: "Only http(s) URLs are allowed." };
    }
    const unsafeHostError = getUnsafeIntegrationHostError(url);
    if (unsafeHostError) {
      return { error: unsafeHostError };
    }

    if (request.query && typeof request.query === "object") {
      for (const [name, value] of Object.entries(
        request.query as Record<string, string | number | boolean>,
      )) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers = new Headers();
    if (request.headers && typeof request.headers === "object") {
      for (const [name, value] of Object.entries(
        request.headers as Record<string, string>,
      )) {
        headers.set(name, value);
      }
    }

    const method = (request.method ?? "GET").toUpperCase();
    if (!/^[A-Z]+$/.test(method)) {
      return { error: "Invalid HTTP method." };
    }
    const timeoutMs =
      typeof request.timeoutMs === "number"
        ? Math.max(1_000, Math.min(request.timeoutMs, 120_000))
        : 30_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (request.body && method !== "GET" && method !== "HEAD") {
        if (typeof request.body === "string") {
          fetchOpts.body = request.body;
        } else {
          fetchOpts.body = JSON.stringify(request.body);
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
        }
      }

      const response = await fetch(url.toString(), fetchOpts);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          error: `HTTP ${response.status} ${response.statusText}`,
          body: text.slice(0, 2000),
        };
      }

      if (responseType === "text") {
        return { data: await response.text() };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return { data: await response.json() };
      }

      return { data: await response.text() };
    } catch (err) {
      return { error: `Request failed: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  },
});
