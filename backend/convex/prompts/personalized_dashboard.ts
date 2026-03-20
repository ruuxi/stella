export type PersonalizedDashboardPageAssignment = {
  pageId: string;
  title: string;
  topic: string;
  focus: string;
  panelName: string;
  dataSources: string[];
  personalOrEntertainment: boolean;
};

const buildPageFocusGuidance = (args: {
  personalOrEntertainment: boolean;
  dataSourcesCount: number;
}): string => {
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
};

export const buildPersonalizedDashboardPageUserMessage = (args: {
  userProfile: string;
  assignment: PersonalizedDashboardPageAssignment;
  promptTemplate: string;
}) => {
  const { assignment } = args;
  const sources = assignment.dataSources.length > 0
    ? assignment.dataSources.map((source) => `- ${source}`).join("\n")
    : "- Find relevant public/free sources matching the page topic.";

  return args.promptTemplate
    .replaceAll("{{pageId}}", assignment.pageId)
    .replaceAll("{{title}}", assignment.title)
    .replaceAll("{{panelName}}", assignment.panelName)
    .replaceAll("{{topic}}", assignment.topic)
    .replaceAll("{{focus}}", assignment.focus)
    .replaceAll("{{suggestedSources}}", sources)
    .replaceAll(
      "{{pageFocusGuidance}}",
      buildPageFocusGuidance({
        personalOrEntertainment: assignment.personalOrEntertainment,
        dataSourcesCount: assignment.dataSources.length,
      }),
    )
    .replaceAll("{{userProfile}}", args.userProfile);
};
