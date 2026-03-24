/**
 * Home Canvas Generation Service
 *
 * Reads the user's core memory and the HomeCanvas.tsx template,
 * sends both to the backend, and receives personalized content
 * constants to replace in the template.
 */

import { createServiceRequest } from "@/infra/http/service-request";
import { getHomeCanvasPromptConfig } from "@/prompts";

export type HomeCanvasResult = {
  content: string;
};

type HomeCanvasRequestOptions = {
  includeAuth?: boolean;
};

export async function generateHomeCanvas(
  coreMemory: string,
  templateFile: string,
  options: HomeCanvasRequestOptions = {},
): Promise<HomeCanvasResult> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/home-canvas",
    { "Content-Type": "application/json" },
    { includeAuth: options.includeAuth ?? true },
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

  return (await response.json()) as HomeCanvasResult;
}
