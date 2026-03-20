/**
 * LLM planning for personalized dashboard pages (Convex + HTTP).
 * Keep in sync with desktop `dashboard_plan.*` prompts in `src/prompts/catalog.ts`.
 */

export const DASHBOARD_PLAN_SYSTEM_PROMPT = `You choose three personalized home “pages” for Stella (a desktop AI workspace): concrete, buildable ideas as single React TSX views. Derive everything from the user’s core memory — work, tools, projects, and personal life (hobbies, games, media, communities, leisure).

Hard rules:
- Output ONLY a JSON array of exactly 3 objects. No markdown fences, no commentary.
- Each object MUST include: "pageId", "title", "topic", "focus", "personalOrEntertainment"
- pageId: unique snake_case (lowercase a-z, digits, underscores), max 40 characters.
- title: short nav label (max 48 characters).
- topic: one sentence describing the page.
- focus: 2–5 sentences: what to build, how it behaves, layout/interaction intent. Be specific to THIS user. Do NOT assume every page is a news feed or “data aggregator.” Mix kinds of experiences when it fits: tools, summaries, trackers, editorial layouts, lightweight games or quizzes, journaling prompts, hobby dashboards, etc. Mention live external data only when it truly serves the idea.
- personalOrEntertainment: boolean. At least ONE of the three objects MUST have personalOrEntertainment: true. Those pages serve entertainment, hobbies, social/community, or personal life — not primary work productivity. The others can be professional or mixed.
- dataSources: OPTIONAL. Include only if the page should pull public HTTP/HTTPS data (RSS, public JSON APIs). Value is an array of 1–5 short hints (e.g. "Hacker News Firebase API"). If the idea is mostly UI, local state, or self-contained logic, omit dataSources or use []. Never require feeds for every page.

If the profile is thin on personal details, still set personalOrEntertainment: true on one page aimed at everyday life balance (e.g. light reading, simple daily check-in, gentle prompts) without inventing fake hobbies.`;

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
