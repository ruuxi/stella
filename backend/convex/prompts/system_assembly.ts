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

const LOCALE_ENGLISH_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ko: "Korean",
  pl: "Polish",
  sv: "Swedish",
  nb: "Norwegian Bokmål",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  el: "Greek",
  tr: "Turkish",
  ro: "Romanian",
  hu: "Hungarian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  he: "Hebrew",
};

/**
 * Returns a one-line "respond in X" directive for the user's locale,
 * or an empty string for English (or unknown tags). Mirrors the runtime
 * helper at `runtime/kernel/runner/locale-prompt.ts` — keep both in
 * sync when adding locales. The directive is composable: callers
 * append it to whatever system-prompt array they already build.
 */
export const getResponseLanguageSystemPrompt = (
  locale: string | null | undefined,
): string => {
  if (!locale) return "";
  const trimmed = locale.trim();
  if (!trimmed) return "";
  if (trimmed === "en" || trimmed.startsWith("en-")) return "";
  const name = LOCALE_ENGLISH_NAMES[trimmed];
  if (!name) return "";
  return [
    `Respond to the user in ${name} (${trimmed}) unless the user explicitly switches.`,
    "Keep code, commands, filenames, API names, and quoted source text in their original language.",
  ].join(" ");
};

export const buildFallbackAgentSystemPrompt = (id: string): string =>
  `You are the ${id} agent.`;
