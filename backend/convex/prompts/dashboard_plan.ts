/**
 * LLM planning for personalized dashboard pages (Convex + HTTP).
 * Keep in sync with desktop `dashboard_plan.*` prompts in `src/prompts/catalog.ts`.
 */

export const DASHBOARD_PLAN_SYSTEM_PROMPT = `You choose three personalized apps for Stella (a personal desktop AI workspace). Each app is a self-contained web application — NOT a dashboard card or summary panel. Think websites, tools, games, trackers, interactive experiences. Derive everything from the user’s core memory — work, tools, projects, and personal life (hobbies, games, media, communities, leisure).

Hard rules:
- Output ONLY a JSON array of exactly 3 objects. No markdown fences, no commentary.
- Each object MUST include: “pageId”, “title”, “topic”, “focus”, “personalOrEntertainment”
- pageId: unique snake_case (lowercase a-z, digits, underscores), max 40 characters.
- title: short nav label (max 48 characters).
- topic: one sentence describing the app.
- focus: 2–5 sentences: what to build, how it behaves, layout/interaction intent. Be specific to THIS user. Think ambitiously — each app should feel like a real website or web app, not a card with some stats. Mix kinds of experiences: interactive tools, live feeds with editorial layouts, lightweight games or quizzes, trackers with rich UI, journaling apps, hobby hubs, community readers, etc. Include a visual direction hint (e.g. “dark terminal aesthetic”, “warm editorial magazine feel”, “playful with bold colors”). Mention live external data only when it truly serves the idea.
- personalOrEntertainment: boolean. At least ONE of the three objects MUST have personalOrEntertainment: true. Those apps serve entertainment, hobbies, social/community, or personal life — not primary work productivity. The others can be professional or mixed.
- dataSources: OPTIONAL. Include only if the app should pull public HTTP/HTTPS data (RSS, public JSON APIs). Value is an array of 1–5 short hints (e.g. “Hacker News Firebase API”). If the idea is mostly UI, local state, or self-contained logic, omit dataSources or use []. Never require feeds for every app.

If the profile is thin on personal details, still set personalOrEntertainment: true on one app aimed at everyday life balance (e.g. light reading, simple daily check-in, gentle prompts) without inventing fake hobbies.`;

export const DASHBOARD_PLAN_USER_PROMPT_TEMPLATE = `CORE MEMORY PROFILE:

{{coreMemory}}

Return the JSON array of exactly 3 objects now. At least one must have "personalOrEntertainment": true.`;

export const buildDashboardPlanUserMessage = (
  coreMemory: string,
  template: string = DASHBOARD_PLAN_USER_PROMPT_TEMPLATE,
): string =>
  template.replace(
    /\{\{coreMemory\}\}/g,
    coreMemory.replace(/\s+/g, " ").trim().slice(0, 14_000),
  );
