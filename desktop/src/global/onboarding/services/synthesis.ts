/**
 * Core Memory Synthesis Service
 *
 * Delegates synthesis through Electron host IPC so onboarding orchestration
 * stays host-coordinated while the backend still owns the actual model work.
 */

import { getSynthesisPromptConfig } from "@/prompts";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import type { OnboardingSynthesisResponse } from "@/shared/contracts/onboarding";

type SynthesisResult = OnboardingSynthesisResponse;

type SynthesisRequestOptions = {
  includeAuth?: boolean;
};

export async function synthesizeCoreMemory(
  formattedSections: Partial<Record<DiscoveryCategory, string>>,
  options: SynthesisRequestOptions = {},
): Promise<SynthesisResult> {
  const onboardingApi = window.electronAPI?.onboarding;
  if (!onboardingApi?.synthesizeCoreMemory) {
    throw new Error(
      "Onboarding synthesis IPC is unavailable in this renderer context.",
    );
  }

  return await onboardingApi.synthesizeCoreMemory({
    formattedSections: formattedSections as Record<string, string>,
    promptConfig: getSynthesisPromptConfig() as Record<string, unknown>,
    includeAuth: options.includeAuth ?? true,
  });
}
