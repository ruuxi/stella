export const buildSkillSelectionUserMessage = (
  userProfile: string,
  catalog: Array<{ id: string; name: string; description: string; tags?: string[] }>,
  promptTemplate: string,
): string => {
  const catalogText = catalog
    .map((skill) =>
      `- ${skill.id}: ${skill.name} - ${skill.description}${
        skill.tags?.length ? ` [${skill.tags.join(", ")}]` : ""
      }`,
    )
    .join("\n");

  return `${promptTemplate}\n\nUser profile:\n${userProfile}\n\nAvailable skills:\n${catalogText}`;
};
