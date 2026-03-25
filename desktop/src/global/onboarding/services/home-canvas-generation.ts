/**
 * Home Canvas Generation Service
 *
 * Calls the backend with the HomeCanvas.tsx template + core memory,
 * receives a rewritten file, and writes it to disk via IPC.
 */

import { createServiceRequest } from "@/infra/http/service-request";
import { getHomeCanvasPromptConfig } from "@/prompts";

type HomeCanvasResponse = {
  content: string;
};

/** Strip markdown code fences if the model wraps its output. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceStart = /^```(?:tsx?|jsx?|typescript|javascript)?\s*\n/;
  const fenceEnd = /\n```\s*$/;
  if (fenceStart.test(trimmed) && fenceEnd.test(trimmed)) {
    return trimmed.replace(fenceStart, "").replace(fenceEnd, "").trim();
  }
  return trimmed;
}

export async function generateHomeCanvas(
  coreMemory: string,
  templateFile: string,
): Promise<void> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/home-canvas",
    { "Content-Type": "application/json" },
    { includeAuth: true },
  );

  const promptConfig = getHomeCanvasPromptConfig();

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...promptConfig,
      coreMemory,
      templateFile,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Home canvas generation failed: ${response.status} - ${errorText}`);
  }

  const { content } = (await response.json()) as HomeCanvasResponse;
  const cleaned = stripFences(content);

  const result = await window.electronAPI?.browser.writeHomeCanvas(cleaned);
  if (result && !result.ok) {
    throw new Error(`Failed to write HomeCanvas: ${result.error}`);
  }
}
