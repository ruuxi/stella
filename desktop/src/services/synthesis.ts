/**
 * Core Memory Synthesis Service
 *
 * Calls the backend synthesis endpoint to:
 * 1. Synthesize collected user signals into a compact CORE_MEMORY profile
 * 2. Generate a personalized welcome message
 */

import { getAuthToken } from "./auth-token";

export type SynthesisResult = {
  coreMemory: string;
  welcomeMessage: string;
};

export async function synthesizeCoreMemory(
  formattedSignals: string,
): Promise<SynthesisResult> {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) {
    throw new Error("VITE_CONVEX_URL is not set.");
  }

  const token = await getAuthToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const httpBaseUrl =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

  const endpoint = new URL("/api/synthesize", httpBaseUrl).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ formattedSignals }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Synthesis failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as SynthesisResult;
}
