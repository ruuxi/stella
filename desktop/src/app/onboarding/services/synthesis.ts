/**
 * Core Memory Synthesis Service
 *
 * Calls the backend synthesis endpoint to:
 * 1. Analyze each discovery category independently (signal filtering)
 * 2. Synthesize the combined analyses into a compact CORE_MEMORY profile
 * 3. Generate a personalized welcome message and suggestions
 */

import { createServiceRequest } from "@/infra/http/service-request";
import { getSynthesisPromptConfig } from "@/prompts";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";

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
  formattedSections: Partial<Record<DiscoveryCategory, string>>,
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
      formattedSections,
      ...getSynthesisPromptConfig(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Synthesis failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as SynthesisResult;
}
