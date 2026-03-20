/** Shared hint block for personalized dashboard generation prompts (renderer + Electron). */
export function buildPageFocusGuidance(args: {
  personalOrEntertainment: boolean;
  dataSourcesCount: number;
}): string {
  const parts: string[] = [];
  if (args.personalOrEntertainment) {
    parts.push(
      "This page is personal/entertainment-first — prioritize warmth, leisure, or self-expression over productivity dashboards.",
    );
  }
  if (args.dataSourcesCount === 0) {
    parts.push(
      "No specific feeds were planned — a self-contained layout (local state, light interactions, or profile-tied prompts) is appropriate; use browser fetch only when you pick a concrete HTTPS URL.",
    );
  }
  return parts.length ? `${parts.join(" ")}\n\n` : "";
}
