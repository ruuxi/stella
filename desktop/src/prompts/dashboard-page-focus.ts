/** Shared hint block for personalized app generation prompts (renderer + Electron). */
export function buildPageFocusGuidance(args: {
  personalOrEntertainment: boolean;
  dataSourcesCount: number;
}): string {
  const parts: string[] = [];
  if (args.personalOrEntertainment) {
    parts.push(
      "This app is personal/entertainment-first — lean into warmth, leisure, personality, or self-expression. Choose an aesthetic that matches the vibe (playful, cozy, bold) rather than defaulting to a productivity look.",
    );
  }
  if (args.dataSourcesCount === 0) {
    parts.push(
      "No specific feeds were planned — a self-contained app (local state, rich interactions, or profile-tied experiences) is appropriate; use browser fetch only when you pick a concrete HTTPS URL.",
    );
  }
  return parts.length ? `${parts.join(" ")}\n\n` : "";
}
