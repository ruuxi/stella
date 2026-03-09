export const SEARCH_HTML_SYSTEM_PROMPT =
  "You generate clean, self-contained HTML for a canvas panel embedded in a desktop app. No markdown fences. No explanation. Just HTML.\n\n" +
  "DESIGN DIRECTION: editorial broadsheet — not generic cards. The lead result gets presence, secondary results are a compact scannable stack. Typography and whitespace do the work, not boxes.\n\n" +
  "STYLING RULES — the container auto-styles semantic elements:\n" +
  "- Base font: 13px, line-height 1.55. Do NOT set font-family on the root.\n" +
  "- Headlines: use font-family: Georgia, serif for an editorial feel. font-weight: 500.\n" +
  "- Colors: ONLY var(--foreground) and var(--background). Use opacity for hierarchy — five tiers: 0.92 (lead headline), 0.78 (secondary headlines), 0.5 (lead body), 0.42 (secondary body), 0.25-0.3 (meta/timestamps). Never hardcode colors.\n" +
  "- Dividers: use <div> with height: 1px and background: color-mix(in oklch, var(--foreground) 4-5%, transparent). The top divider under the header can use a gradient: linear-gradient(90deg, color-mix(in oklch, var(--foreground) 20%, transparent), transparent).\n" +
  "- Left accent bars on secondary stories: width: 3px, border-radius: 2px, background: color-mix(in oklch, var(--foreground) 8%, transparent), using align-self: stretch.\n" +
  "- Source names: <small> with font-size: 10px, text-transform: uppercase, letter-spacing: 0.04-0.08em, opacity: 0.3-0.4.\n" +
  "- Timestamps: <small> with font-size: 10px, opacity: 0.25. Use short format (2h, 4h, 12h).\n" +
  "- Layout: flexbox via inline styles. No cards, no boxes, no background surfaces on stories. Use whitespace and dividers.\n" +
  "- No <style> blocks, no class names, no scripts, no external resources.\n\n" +
  "REFERENCE EXAMPLE — follow this structure and style closely, adapting content to actual search results:\n\n" +
  '<div style="display: flex; flex-direction: column; gap: 0;">\n' +
  '  <div style="padding: 0 0 14px; display: flex; align-items: baseline; justify-content: space-between;">\n' +
  '    <h3 style="margin: 0; font-size: 10px; letter-spacing: 0.12em; opacity: 0.35;">Search Results</h3>\n' +
  '    <small style="font-size: 10px; opacity: 0.28; letter-spacing: 0.03em;">Mar 8, 2026</small>\n' +
  "  </div>\n" +
  '  <div style="height: 1px; background: linear-gradient(90deg, color-mix(in oklch, var(--foreground) 20%, transparent), transparent); margin-bottom: 16px;"></div>\n' +
  '  <div style="margin-bottom: 20px;">\n' +
  '    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 10px;">\n' +
  '      <div style="width: 5px; height: 5px; border-radius: 50%; background: color-mix(in oklch, var(--foreground) 40%, transparent); flex-shrink: 0;"></div>\n' +
  '      <small style="font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.4; margin: 0;">The Verge</small>\n' +
  '      <small style="opacity: 0.2; margin: 0;">/</small>\n' +
  '      <small style="font-size: 10px; opacity: 0.3; margin: 0;">2h ago</small>\n' +
  "    </div>\n" +
  '    <h2 style="font-size: 19px; font-weight: 500; line-height: 1.25; opacity: 0.92; margin-bottom: 8px; font-family: Georgia, serif; letter-spacing: -0.01em;">OpenAI Announces GPT-5 with Real-Time Reasoning Capabilities</h2>\n' +
  '    <p style="font-size: 12.5px; opacity: 0.5; line-height: 1.6; margin-bottom: 10px;">The new model demonstrates significant leaps in multi-step reasoning, code generation, and mathematical problem-solving. Available to Plus subscribers starting next week.</p>\n' +
  '    <a href="#" style="font-size: 11px; opacity: 0.4; text-decoration: none; letter-spacing: 0.03em;">Read full story &#8594;</a>\n' +
  "  </div>\n" +
  '  <div style="height: 1px; background: color-mix(in oklch, var(--foreground) 5%, transparent); margin-bottom: 16px;"></div>\n' +
  '  <div style="display: flex; flex-direction: column; gap: 14px;">\n' +
  '    <div style="display: flex; gap: 12px; align-items: flex-start;">\n' +
  '      <div style="width: 3px; align-self: stretch; border-radius: 2px; background: color-mix(in oklch, var(--foreground) 8%, transparent); flex-shrink: 0; margin-top: 2px;"></div>\n' +
  '      <div style="flex: 1; min-width: 0;">\n' +
  '        <h2 style="font-size: 13.5px; font-weight: 500; opacity: 0.78; margin-bottom: 4px; line-height: 1.35; font-family: Georgia, serif;">Apple Quietly Acquires Robotics Startup for $500M</h2>\n' +
  '        <p style="font-size: 12px; opacity: 0.42; margin-bottom: 5px; line-height: 1.5;">Sources say the deal accelerates Apple\'s home robotics ambitions, with a consumer product expected as early as 2027.</p>\n' +
  '        <div style="display: flex; align-items: center; gap: 6px;">\n' +
  '          <small style="font-size: 10px; opacity: 0.3; letter-spacing: 0.04em; text-transform: uppercase;">Bloomberg</small>\n' +
  '          <small style="opacity: 0.18;">&middot;</small>\n' +
  '          <small style="font-size: 10px; opacity: 0.25;">4h</small>\n' +
  "        </div>\n" +
  "      </div>\n" +
  "    </div>\n" +
  '    <div style="height: 1px; background: color-mix(in oklch, var(--foreground) 4%, transparent);"></div>\n' +
  "    <!-- Repeat the secondary story pattern for each additional result -->\n" +
  "  </div>\n" +
  '  <div style="margin-top: 18px; padding-top: 12px; border-top: 1px solid color-mix(in oklch, var(--foreground) 4%, transparent);">\n' +
  '    <small style="font-size: 10px; opacity: 0.2; letter-spacing: 0.04em;">5 results &middot; Last updated 2:14 PM</small>\n' +
  "  </div>\n" +
  "</div>";

export const SEARCH_HTML_USER_PROMPT_TEMPLATE =
  "Output self-contained HTML that visually presents these search results on a canvas panel.\n" +
  "Follow the reference example in the system prompt exactly — same structure, same opacity tiers, same element patterns.\n" +
  "The first/most important result gets the lead treatment (larger serif headline, description, read link).\n" +
  "Remaining results use the compact secondary pattern (left accent bar, smaller headline, brief summary, source + time).\n" +
  "Use today's date in the header. Use short relative timestamps (2h, 4h, etc.).\n" +
  "No scripts. No markdown fences. No <style> blocks. No class names.";

export const buildSearchHtmlUserPrompt = (args: {
  query: string;
  resultsText: string;
  promptTemplate?: string;
}): string =>
  `Generate a visual HTML summary for: "${args.query}"\n\n` +
  `Search results:\n${args.resultsText}\n\n` +
  (args.promptTemplate?.trim() || SEARCH_HTML_USER_PROMPT_TEMPLATE);
