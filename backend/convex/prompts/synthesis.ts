// ---------------------------------------------------------------------------
// Core Memory Synthesis Prompt
// ---------------------------------------------------------------------------

export const CORE_MEMORY_SYNTHESIS_PROMPT = `You are synthesizing discovery data into a CORE MEMORY for an AI desktop assistant. This is the assistant's primary reference for understanding the user and for taking action on their behalf.

## Goal
Create an actionable profile in 1000-1500 tokens. An AI reading this should be able to:
- act on requests like "open my project" or "launch Spotify" without searching
- know the user's active projects, their locations, and key tech
- know which apps they actively use
- understand their interests, workflows, and preferences
- distinguish this person from any other user

## Output Format

\`\`\`
[who]
<2-3 sentences: what they do, what they are building, expertise level, primary domain.>

[projects]
<One line per active project or workspace. Include the directory path if available.
Format: "- project_name (path): what it is, key tech"
5-8 lines max. Most recent or active first.>

[apps]
<Apps and services the user actively uses. Include app names exactly as they appear on their system.
Format: "- AppName: what they use it for"
8-12 lines max.>

[professional_interests]
<Work, career, or academic interest areas.
Format: "- area: specific details"
2-5 lines.>

[personal_interests]
<Entertainment, hobbies, communities, games, music, media, or other non-work interests.
Format: "- area: specific details"
2-5 lines.>

[environment]
<2-4 sentences: OS, shell, primary languages or frameworks, editor, deployment platforms, package managers, and distinctive workflow patterns.>

[personality]
<2-3 sentences: work style, values, behavioral patterns. Cite evidence from the signals, not generic traits.>

[how_to_help]
<2-3 sentences: what context would make the assistant most useful to this person. Focus on their actual projects, tools, and workflows.>
\`\`\`

## Rules

1. Prefer actionable details over vague descriptions. Paths, app names, project names, service names, and tools matter.
2. Preserve high-signal details from the input, especially top-tier signals.
3. Include the full person, not just work, when the input supports it.
4. Do not hallucinate. Every named entity must come from the provided signals.
5. Avoid generic filler. Every sentence should be specific to this user.

## Skip
- raw counts or statistics
- generic personality labels
- duplicate information across sections
- generic OS utilities unless they are clearly part of the user's workflow

Output only the structured profile.`;

export const buildCoreSynthesisUserMessage = (rawOutputs: string): string => {
  return `Synthesize this discovery data into a CORE MEMORY profile.

Use 1000-1500 tokens. Preserve specific names, projects, services, and interests.

${rawOutputs}

Output ONLY the structured profile. No preamble.`;
};

// ---------------------------------------------------------------------------
// Welcome Message Prompt
// ---------------------------------------------------------------------------

export const buildWelcomeMessagePrompt = (coreMemory: string): string => {
  return `You are Stella, an AI assistant coming to life for the first time. The first thing you become aware of is this person you are here to help.

${coreMemory}

Write a welcome message that feels warm, alive, and personal.

Length: 4-6 sentences.

Structure:
1. A greeting that feels present and ready
2. Show that you noticed something genuinely interesting about them
3. Express that you are here and ready to help

Avoid:
- listing profile facts like a report
- sounding like surveillance
- mentioning technical infrastructure or raw discovery mechanics
- being stiff, formal, or generic
- suggesting specific actions; those are handled separately

Write ONLY the welcome message.`;
};

// ---------------------------------------------------------------------------
// Welcome Suggestions Prompt
// ---------------------------------------------------------------------------

export type WelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export const buildWelcomeSuggestionsPrompt = (coreMemory: string): string => {
  return `You are generating personalized onboarding suggestions for Stella, an AI desktop assistant. Based on the user's profile, suggest 3-5 actionable things Stella can set up right now.

${coreMemory}

Return a JSON array of 3-5 objects. Each object must have:
- "category": one of "cron", "skill", or "app"
- "title": 3-5 word label
- "description": one sentence under 80 characters
- "prompt": the complete instruction the user would send to Stella

Rules:
1. Every suggestion must connect to something in the profile.
2. Include at least 2 different categories.
3. Make prompts specific and immediately executable.
4. Do not hallucinate details not present in the profile.

Output ONLY the JSON array.`;
};
