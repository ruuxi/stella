import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";

type JsonRequest =
  | {
      method: "GET";
      headers?: Record<string, string>;
    }
  | {
      method: "POST";
      body: string;
      headers?: Record<string, string>;
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
      ...(request.method === "POST"
        ? { "Content-Type": "application/json" }
        : {}),
      ...request.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as unknown;
}

export const getJson = (
  path: string,
  options?: { headers?: Record<string, string> },
) => requestJson(path, { method: "GET", headers: options?.headers });

export const postJson = (
  path: string,
  body: unknown,
  options?: { headers?: Record<string, string> },
) =>
  requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: options?.headers,
  });

export function postStream(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
): Promise<void> {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");

  return new Promise((resolve, reject) => {
    void getConvexToken().then((token) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${env.convexSiteUrl}${path}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.responseType = "text";

      let processed = 0;

      xhr.onprogress = () => {
        const chunk = xhr.responseText.slice(processed);
        processed = xhr.responseText.length;

        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as { t?: string; error?: string };
            if (parsed.error) {
              reject(new Error(parsed.error));
              xhr.abort();
              return;
            }
            if (parsed.t) onDelta(parsed.t);
          } catch {
            // skip malformed lines
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let msg = "Could not complete that request. Try again.";
          try {
            const parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
            if (typeof parsed.error === "string") msg = parsed.error;
            else if (typeof parsed.message === "string") msg = parsed.message;
          } catch { /* use default */ }
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => reject(new Error("Network error"));
      xhr.ontimeout = () => reject(new Error("Request timed out"));

      xhr.send(JSON.stringify(body));
    }).catch(reject);
  });
}
