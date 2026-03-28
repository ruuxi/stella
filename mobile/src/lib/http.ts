import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";

type JsonRequest =
  | {
      method: "GET";
    }
  | {
      method: "POST";
      body: string;
    };

const readErrorMessage = async (response: Response) => {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "Could not complete that request. Try again.";
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.error === "string" && o.error.trim()) {
      return o.error.trim();
    }
    if (typeof o.message === "string" && o.message.trim()) {
      return o.message.trim();
    }
  }
  return "Could not complete that request. Try again.";
};

async function requestJson(path: string, request: JsonRequest) {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  const response = await fetch(`${env.convexSiteUrl}${path}`, {
    ...request,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as unknown;
}

export const getJson = (path: string) => requestJson(path, { method: "GET" });

export const postJson = (path: string, body: unknown) =>
  requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
