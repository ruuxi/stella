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

type WelcomeMessageResult = {
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

/**
 * Seed discovery signals into ephemeral memory (fire-and-forget).
 * This runs after core memory synthesis to populate the memories table
 * with categorized facts extracted from discovery data.
 */
export async function seedDiscoveryMemories(
  formattedSignals: string,
): Promise<void> {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) return;

  const token = await getAuthToken();
  if (!token) return;

  const httpBaseUrl =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

  const endpoint = new URL("/api/seed-memories", httpBaseUrl).toString();

  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ formattedSignals }),
  }).catch(() => {
    // Silent fail - memory seeding is non-critical
  });
}

/**
 * Generate a welcome message from existing core memory.
 */
export async function generateWelcomeMessageFromCoreMemory(
  coreMemory: string,
): Promise<string> {
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

  const endpoint = new URL("/api/welcome-message", httpBaseUrl).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ coreMemory }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Welcome generation failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as WelcomeMessageResult;
  return result.welcomeMessage?.trim() ?? "";
}
