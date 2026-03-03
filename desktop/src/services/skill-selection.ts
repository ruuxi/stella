/**
 * Default Skill Selection Service
 *
 * After onboarding synthesis, calls the backend to select relevant skills
 * for the user based on their core memory profile.
 */

import { createServiceRequest } from "./http/service-request";

export type SkillSelectionResult = {
  selectedSkillIds: string[];
};

export async function selectDefaultSkills(
  coreMemory: string,
): Promise<SkillSelectionResult> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/select-default-skills",
    { "Content-Type": "application/json" },
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ coreMemory }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Skill selection failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as SkillSelectionResult;
}
