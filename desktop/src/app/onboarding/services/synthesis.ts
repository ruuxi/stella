/**
 * Core Memory Synthesis Service
 *
 * Calls the backend synthesis endpoint to:
 * 1. Synthesize collected user signals into a compact CORE_MEMORY profile
 * 2. Generate a personalized welcome message
 */

import { createServiceRequest } from "@/infra/http/service-request";
import { getSynthesisPromptConfig } from "@/prompts";

export type WelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export type SynthesisResult = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions?: WelcomeSuggestion[];
};

type SynthesisRequestOptions = {
  includeAuth?: boolean;
};

export async function synthesizeCoreMemory(
  formattedSignals: string,
  options: SynthesisRequestOptions = {},
): Promise<SynthesisResult> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/synthesize",
    {
      "Content-Type": "application/json",
    },
    {
      includeAuth: options.includeAuth ?? true,
    },
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      formattedSignals,
      ...getSynthesisPromptConfig(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Synthesis failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as SynthesisResult;
}
