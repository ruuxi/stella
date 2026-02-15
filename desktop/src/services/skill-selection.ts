/**
 * Default Skill Selection Service
 *
 * After onboarding synthesis, calls the backend to select relevant skills
 * for the user based on their core memory profile.
 */

export type SkillSelectionResult = {
  selectedSkillIds: string[];
};

export async function selectDefaultSkills(
  coreMemory: string,
): Promise<SkillSelectionResult> {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) {
    throw new Error("VITE_CONVEX_URL is not set.");
  }

  const httpBaseUrl =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

  const endpoint = new URL("/api/select-default-skills", httpBaseUrl).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ coreMemory }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Skill selection failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as SkillSelectionResult;
}
