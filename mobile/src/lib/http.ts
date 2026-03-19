import { env } from "../config/env";
import { assert, assertObject } from "./assert";
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
  const parsed = (await response.json()) as unknown;
  assertObject(parsed, "Request failed.");
  assert(typeof parsed.error === "string", "Request failed.");
  return parsed.error;
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
