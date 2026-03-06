/**
 * Local profile synthesis for onboarding discovery.
 *
 * The signal collector already produces a structured summary, so this step
 * normalizes that local output into the profile document we persist on disk
 * and adds a lightweight welcome payload for the first-run UI.
 */

export type WelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export type SynthesisResult = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions?: WelcomeSuggestion[];
};

type SynthesisRequestOptions = {
  includeAuth?: boolean;
};

const MAX_CORE_MEMORY_LENGTH = 24_000;

const DEFAULT_SUGGESTIONS: WelcomeSuggestion[] = [
  {
    category: "skill",
    title: "Summarize my setup",
    description: "Ask Stella what it learned from your local profile.",
    prompt: "Summarize what you learned about me from my local profile.",
  },
  {
    category: "cron",
    title: "Plan a routine",
    description: "Turn your profile into one useful recurring workflow.",
    prompt: "Suggest one practical daily or weekly routine based on my local profile.",
  },
  {
    category: "app",
    title: "Tune my workspace",
    description: "Use your profile to improve apps, layout, or habits.",
    prompt: "Based on my local profile, suggest how Stella should tailor my workspace and app setup.",
  },
];

const normalizeCoreMemory = (formattedSignals: string) =>
  formattedSignals
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CORE_MEMORY_LENGTH);

const includesAny = (value: string, keywords: string[]) =>
  keywords.some((keyword) => value.includes(keyword));

const buildWelcomeMessage = (coreMemory: string) => {
  const lower = coreMemory.toLowerCase();

  if (
    includesAny(lower, [
      "developer",
      "engineering",
      "typescript",
      "javascript",
      "python",
      "git",
      "repo",
      "project",
      "terminal",
    ])
  ) {
    return "I put together a first pass at your local profile. I can already help with your projects, tools, and workflow.";
  }

  if (
    includesAny(lower, [
      "calendar",
      "notes",
      "messages",
      "reminders",
      "routine",
      "schedule",
    ])
  ) {
    return "I put together a first pass at your local profile. I can help organize your messages, notes, and routines from here.";
  }

  return "I put together a first pass at your local profile. I can use it to tailor help, suggestions, and automations on this device.";
};

export async function synthesizeCoreMemory(
  formattedSignals: string,
  _options: SynthesisRequestOptions = {},
): Promise<SynthesisResult> {
  const coreMemory = normalizeCoreMemory(formattedSignals);
  if (!coreMemory) {
    return {
      coreMemory: "",
      welcomeMessage: "",
      suggestions: [],
    };
  }

  return {
    coreMemory,
    welcomeMessage: buildWelcomeMessage(coreMemory),
    suggestions: DEFAULT_SUGGESTIONS,
  };
}
