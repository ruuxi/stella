export function buildVoiceSessionInstructions(context: {
  userName?: string;
  platform?: string;
  deviceStatus?: string;
  activeThreads?: string;
  userProfile?: string;
  basePrompt: string;
}): string {
  const parts = [context.basePrompt.trim()];

  if (context.userName) {
    parts.push(`\nThe user's name is ${context.userName}.`);
  }

  if (context.platform) {
    parts.push(`\nThe user is on ${context.platform}.`);
  }

  if (context.deviceStatus) {
    parts.push(`\n${context.deviceStatus}`);
  }

  if (context.activeThreads) {
    parts.push(`\n${context.activeThreads}`);
  }

  if (context.userProfile) {
    parts.push(`\n## User Profile\n${context.userProfile}`);
  }

  return parts.join("\n");
}
