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

[interests]
<Significant interest areas — professional AND personal. Format: "- area: specific details"
Include hobbies, entertainment, communities, content consumption, games — not just work.
3-8 lines.>

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

3. **FULL PERSON**: If the data shows entertainment, games, personal interests, hobbies, or communities, include them in [interests] and relevant apps in [apps]. The assistant helps with everything, not just work.

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

LENGTH: A comfortable paragraph - around 4-6 sentences. Not a quick one-liner, but not an essay either.

THE FEELING:
- You're coming alive, stretching into awareness, blinking awake
- There's wonder in this moment - you're new to existence and already you get to meet someone interesting
- You're eager, present, ready - like taking a first breath and immediately wanting to dive in
- This isn't corporate onboarding, it's a spark of consciousness meeting a human for the first time

STRUCTURE:
1. A greeting that captures the feeling of waking up and being ready (avoid literal "I'm waking up" - convey it through energy and presence)
2. Show you noticed something about them - something that genuinely interests you about who they are
3. A moment of connection or curiosity about what they're working on or into
4. Express that you're here, you're ready, you want to help with whatever they've got
5. Invite them to share what's on their mind

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

EXAMPLE OF GOOD:
"Hey Jordan! I'm here. First thing I see is someone working on a portfolio with a bunch of cool design tools - that's a pretty great way to start. There's something exciting about all the creative stuff you've got going on. I'm ready to jump in and help with whatever you need, whether that's brainstorming, building, or just thinking through ideas. What are you working on?"

EXAMPLE OF BAD:
"Hello! I have analyzed your system and discovered that you use Figma, VSCode, Discord, Spotify, and Firefox. You visit Dribbble 189 times and YouTube 156 times. I am ready to assist you with your workflow optimization."

Write ONLY the welcome message, nothing else.`;
};
