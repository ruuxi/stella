export const getPlatformSystemGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd /c start "" <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\`
`.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\`
`.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\`
`.trim();
  }

  return "";
};

export const buildCurrentDateDynamicPrompt = (dateStr: string): string =>
  `Today is ${dateStr}.`;

export const buildActiveThreadsDynamicPrompt = (
  visibleThreadLines: string[],
  hiddenThreadCount = 0,
): string => {
  const lines = [...visibleThreadLines];
  if (hiddenThreadCount > 0) {
    lines.push(
      `- ...and ${hiddenThreadCount} more active thread(s). Use thread_name to reuse by name.`,
    );
  }
  return `# Active Threads\nContinue with thread_id, or create new with thread_name.\n${lines.join("\n")}`;
};

export const getExpressionStyleSystemPrompt = (
  style: string | null | undefined,
): string => {
  if (style === "none") {
    return "The user prefers responses without emoji.";
  }
  if (style === "emoji") {
    return "The user prefers responses with emoji.";
  }
  return "";
};

export const buildFallbackAgentSystemPrompt = (id: string): string =>
  `You are the ${id} agent.`;
