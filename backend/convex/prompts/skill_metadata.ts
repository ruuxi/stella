export const buildSkillMetadataUserMessage = (
  skillDirName: string,
  markdown: string,
  promptTemplate: string,
): string => {
  const truncated = markdown.length > 4000 ? `${markdown.slice(0, 4000)}\n...` : markdown;
  return `${promptTemplate}\n\nDirectory name: ${skillDirName}\n\nSkill content:\n${truncated}`;
};
