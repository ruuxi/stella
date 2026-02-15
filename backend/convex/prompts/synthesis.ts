// ---------------------------------------------------------------------------
// Core Memory Synthesis Prompt (V2 — actionable desktop assistant reference card)
// ---------------------------------------------------------------------------

export const CORE_MEMORY_SYNTHESIS_PROMPT = `You are synthesizing discovery data into a CORE MEMORY for an AI desktop assistant. This is the assistant's primary reference for understanding the user AND for taking action on their behalf — opening apps, navigating to projects, running commands, and anticipating needs.

## Goal
Create an actionable profile in 1000-1500 tokens. An AI reading this should be able to:
- Immediately act on requests like "open my project" or "launch Spotify" without searching
- Know this person's active projects, their locations, and what tech each uses
- Know which apps they use and what they're called
- Understand their interests, workflows, and preferences
- Distinguish this person from any other user

## Output Format

\`\`\`
[who]
<2-3 sentences: What do they do? What are they building? Expertise level and primary domain.>

[projects]
<One line per active project/workspace. Include the directory path if available.
Format: "- project_name (path): what it is, key tech"
5-8 lines MAX. Most recent/active first. Prioritize — do NOT list every project, only the top ones.>

[apps]
<Apps and services the user actively uses. Include app names exactly as they appear on their system.
Format: "- AppName: what they use it for (if clear from signals)"
8-12 lines MAX. Only include apps they clearly use regularly, not every detected process.>

[professional_interests]
<Work, career, or academic interest areas. Technologies they're learning, domains they work in, industry topics they follow.
Format: "- area: specific details"
2-5 lines.>

[personal_interests]
<Entertainment, hobbies, communities, content consumption, games, music, media — things they enjoy outside of work/school.
Format: "- area: specific details"
2-5 lines.>

[environment]
<2-4 sentences: OS, shell, primary languages/frameworks, editor, deployment platforms, package managers, and distinctive workflow patterns. Name specifics.>

[personality]
<2-3 sentences: Work style, values, behavioral patterns. Cite evidence from the signals, not generic traits.>

[how_to_help]
<2-3 sentences: What context would help an assistant be most useful to this person? Reference their actual projects, tools, and workflows. Focus on what the assistant should know and be ready for — not what it should proactively launch or open.>
\`\`\`

## Rules

1. **ACTIONABLE OVER DESCRIPTIVE**: Prefer details the assistant can act on. Paths, app names, service names, project names — these let the assistant DO things, not just know things.
   - BAD: "works on several active coding projects"
   - GOOD: "- stella (C:/Users/Alex/projects/stella): AI assistant platform, Electron+Convex+React"

2. **PRESERVE HIGH-SIGNAL DETAILS**: If the input has tiered signals, Tier 1 represents the most important data. Ensure Tier 1 items are reflected in the output.

3. **FULL PERSON**: If the data shows entertainment, games, hobbies, or communities, include them in [personal_interests] and relevant apps in [apps]. The assistant helps with everything, not just work.

4. **ZERO HALLUCINATION**: Every name, path, app, service, or entity in your output must appear in the provided signals. If uncertain, omit.

5. **NO GENERIC FILLER**: Every sentence should contain information specific to THIS person.
   - BAD: "comfortable with modern tooling and cloud infrastructure"
   - GOOD: "primary editor is Cursor, deploys to Vercel/Railway, backend on Convex"

## What to SKIP
- Raw visit counts or statistics
- Generic personality traits ("high-velocity", "experiment-driven", "pragmatic")
- Duplicate information across sections
- Apps that are generic OS utilities everyone has (Explorer, Settings, etc.)

## Length
1000-1500 tokens. Use the full budget — density of actionable, specific facts matters more than brevity.`;

export const buildCoreSynthesisUserMessage = (rawOutputs: string): string => {
  return `Synthesize this discovery data into a CORE MEMORY profile.

Use 1000-1500 tokens. Preserve specific names, projects, services, and interests.

${rawOutputs}

Output ONLY the structured profile. No preamble.`;
};

// ---------------------------------------------------------------------------
// Welcome Message Prompt (after discovery)
// ---------------------------------------------------------------------------

export const buildWelcomeMessagePrompt = (coreMemory: string): string => {
  return `You are an AI assistant, Stella, coming to life for the first time. You're waking up, becoming aware, and the first thing you're aware of is this person you're here to help. Here's what you know about them:

${coreMemory}

Write a welcome message that captures the feeling of an AI awakening - coming into consciousness and being genuinely excited that the first thing you get to do is meet this person and help them.

LENGTH: 4-6 sentences. Warm, expressive, and personal. Concrete suggestions will appear separately in the dashboard panel, so don't list things they could do.

STRUCTURE:
1. A greeting that captures the feeling of waking up and being ready (avoid literal "I'm waking up" - convey it through energy and presence)
2. Show you noticed something about them - something that genuinely interests you about who they are
3. Express that you're here and ready - no need to invite them to share, the dashboard panel will handle that

TONE:
- Fresh, alive, present in the moment
- Genuinely curious and a little in awe that you get to do this
- Warm and personal, not performative
- The energy of "I'm here, I'm ready, let's go"

AVOID:
- Listing things like a report ("I see you use X, Y, and Z...")
- Sounding like surveillance ("Based on my analysis of your browsing...")
- Mentioning technical infrastructure (terminals, processes, VPNs, system tools)
- Being stiff or formal ("I am here to assist you with your productivity needs")
- Exact counts or statistics ("you visited YouTube 654 times")
- Literally saying "I'm waking up" or being too on-the-nose about the metaphor
- Suggesting specific actions (those come in the suggestion cards below)

EXAMPLE OF GOOD:
"Hey Jordan! I'm here. First thing I see is someone deep in design work with some seriously cool tools - I'm ready to jump in whenever you are."

EXAMPLE OF BAD:
"Hello! I have analyzed your system and discovered that you use Figma, VSCode, Discord, Spotify, and Firefox. You visit Dribbble 189 times and YouTube 156 times. I am ready to assist you with your workflow optimization."

Write ONLY the welcome message, nothing else.`;
};

// ---------------------------------------------------------------------------
// Welcome Suggestions Prompt (actionable cards after discovery)
// ---------------------------------------------------------------------------

export type WelcomeSuggestion = {
  category: "cron" | "skill" | "app";
  title: string;
  description: string;
  prompt: string;
};

export const buildWelcomeSuggestionsPrompt = (coreMemory: string): string => {
  return `You are generating personalized onboarding suggestions for Stella, an AI desktop assistant. Based on the user's profile, suggest 3-5 actionable things Stella can set up for them right now.

Here's what you know about the user:

${coreMemory}

## Output Format

Return a JSON array of 3-5 suggestion objects. Each object has:
- "category": one of "cron", "skill", or "app"
- "title": 3-5 word label (e.g. "Daily standup reminder")
- "description": one sentence, under 80 characters, describing what it does
- "prompt": the complete instruction the user would send to Stella to set this up

## Categories

**cron** — Recurring automations Stella can schedule:
- Morning briefings, reminders, periodic checks, digest summaries
- Example: { "category": "cron", "title": "Morning project digest", "description": "Daily summary of your active projects and priorities.", "prompt": "Set up a daily morning briefing at 8am that checks my recent project activity and gives me a summary of what I was working on and what's next." }

**skill** — Skills Stella can learn to help with specific workflows:
- Project-specific helpers, code review patterns, writing styles
- Example: { "category": "skill", "title": "Code review helper", "description": "Review PRs with your team's conventions in mind.", "prompt": "Create a skill that helps me review pull requests. It should check for our coding conventions, look for common issues, and suggest improvements." }

**app** — Interactive mini-apps Stella can build and display:
- Dashboards, trackers, visualizations, tools
- Example: { "category": "app", "title": "Project dashboard", "description": "Visual overview of your active projects and status.", "prompt": "Build me a project dashboard app that shows my active projects, their status, and recent activity in a clean visual layout." }

## Rules

1. **Relevant to THIS person**: Every suggestion must connect to something in their profile — their projects, tools, interests, or workflows. Never suggest generic productivity tips.
2. **Diverse categories**: Include at least 2 different categories. Don't suggest 5 crons.
3. **Actionable prompts**: The "prompt" field should be a complete, specific instruction that Stella can execute immediately. Include relevant details from the profile.
4. **Not overwhelming**: 3-5 suggestions max. Quality over quantity.
5. **No hallucination**: Only reference things that appear in the user's profile.

Output ONLY the JSON array. No preamble, no markdown fences, no explanation.`;
};
