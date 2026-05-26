import type { OnboardingSynthesisResponse } from "@/shared/contracts/onboarding";

export type OnboardingFirstReport = {
  slug: string;
  title: string;
  html: string;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const splitLines = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 10);

const fallbackIdeas = [
  "Create a Stella skill for recurring project conventions and verification commands.",
  "Build a small Stella app that tracks repeated work, current projects, and open follow-ups.",
  "Set up a daily report that turns recent activity into reusable workflows and next actions.",
  "Save a workflow for packaging repeated deliverables into docs, decks, spreadsheets, or canvases.",
];

export function buildOnboardingFirstReport(
  synthesis: OnboardingSynthesisResponse,
): OnboardingFirstReport {
  const analyses = synthesis.categoryAnalyses ?? {};
  const sourceLines = [
    ...splitLines(analyses.dev_environment),
    ...splitLines(analyses.apps_system),
    ...splitLines(analyses.browsing_bookmarks),
    ...splitLines(analyses.messages_notes),
    ...splitLines(synthesis.coreMemory),
  ];
  const ideas = (sourceLines.length > 0 ? sourceLines : fallbackIdeas).slice(0, 8);
  const cards = ideas
    .map((idea) => {
      const text = escapeHtml(idea);
      return `<article class="card"><p>${text}</p></article>`;
    })
    .join("\n");

  return {
    slug: "report-welcome",
    title: "Report - Welcome",
    html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Report - Welcome</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Manrope:wght@400;500;600&display=swap');
    :root {
      color-scheme: dark light;
      --bg: #111315;
      --panel: rgba(255,255,255,0.055);
      --line: rgba(255,255,255,0.13);
      --text: rgba(255,255,255,0.9);
      --muted: rgba(255,255,255,0.62);
      --accent: #7fb2ff;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 20% 0%, rgba(127,178,255,0.14), transparent 28%), var(--bg);
      color: var(--text);
      font-family: Manrope, system-ui, sans-serif;
    }
    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 34px 28px 44px;
    }
    h1 {
      margin: 0;
      font-family: "Cormorant Garamond", Georgia, serif;
      font-size: clamp(38px, 7vw, 68px);
      line-height: 0.95;
      letter-spacing: 0;
    }
    .dek {
      max-width: 650px;
      margin: 16px 0 28px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.75;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .card {
      min-height: 116px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 16px;
    }
    .card p {
      margin: 0;
      font-size: 14px;
      line-height: 1.65;
    }
    .hint {
      margin-top: 24px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .hint strong { color: var(--accent); font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Report - Welcome</h1>
    <p class="dek">A first pass at reusable workflows, skills, and app ideas Stella can help turn into repeatable systems.</p>
    <section class="grid" aria-label="Suggested reusable workflows">
      ${cards}
    </section>
    <p class="hint"><strong>Tip:</strong> Select any workflow text and choose Ask Stella to place it into chat.</p>
  </main>
</body>
</html>`,
  };
}
