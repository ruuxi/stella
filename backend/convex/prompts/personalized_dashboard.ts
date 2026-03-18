export type PersonalizedDashboardPageAssignment = {
  pageId: string;
  title: string;
  topic: string;
  focus: string;
  panelName: string;
  dataSources: string[];
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
    .replaceAll("{{userProfile}}", args.userProfile);
};
