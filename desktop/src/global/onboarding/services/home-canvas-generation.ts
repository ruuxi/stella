/**
 * Home Canvas Generation Service
 *
 * Delegates backend generation through Electron host IPC so onboarding keeps a
 * single host-coordinated boundary for remote generation work.
 */

import { getHomeCanvasPromptConfig } from "@/prompts";
import type { OnboardingHomeCanvasResponse } from "@/shared/contracts/onboarding";

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

/** Fetch the generated HomeCanvas content from the backend without writing to disk. */
export async function fetchHomeCanvas(
  coreMemory: string,
  templateFile: string,
): Promise<string> {
  const onboardingApi = window.electronAPI?.onboarding;
  if (!onboardingApi?.generateHomeCanvas) {
    throw new Error(
      "Onboarding home canvas IPC is unavailable in this renderer context.",
    );
  }

  const { content } = (await onboardingApi.generateHomeCanvas({
    coreMemory,
    templateFile,
    promptConfig: getHomeCanvasPromptConfig() as Record<string, unknown>,
  })) as OnboardingHomeCanvasResponse;

  return stripFences(content);
}

/** Write the generated HomeCanvas content to disk, triggering HMR. */
export async function writeHomeCanvasToDisk(content: string): Promise<void> {
  const result = await window.electronAPI?.browser.writeHomeCanvas(content);
  if (result && !result.ok) {
    throw new Error(`Failed to write HomeCanvas: ${result.error}`);
  }
}
