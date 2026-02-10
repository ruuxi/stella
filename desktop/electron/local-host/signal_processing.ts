/**
 * Signal Processing — filtering and tiering for synthesis input.
 *
 * Applied as post-processing on formatted signals before sending to the LLM.
 * - filterLowSignalDomains: removes low-visit-count domains using an adaptive threshold
 * - tierFormattedSignals: reorganizes flat sections into priority tiers
 */

const log = (...args: unknown[]) => console.log("[signal-processing]", ...args);

// ---------------------------------------------------------------------------
// Low-Signal Domain Filtering
// ---------------------------------------------------------------------------

/** AI chat sites whose page titles reveal user intent — always kept regardless of count */
const AI_CHAT_SITES = new Set([
  "chatgpt.com", "chat.openai.com", "claude.ai", "clawdbot.ai",
  "gemini.google.com", "chat.deepseek.com", "poe.com",
  "perplexity.ai", "copilot.microsoft.com", "grok.x.ai",
]);

/** Minimum page-title count for non-chat sites in Content Details */
const TITLE_MIN_COUNT = 3;

/**
 * Remove low-visit-count domains from browser signals.
 *
 * Formula: threshold = max(ABSOLUTE_MIN, top5_avg * RELATIVE_FACTOR)
 * - ABSOLUTE_MIN = 5 — always drops domains with < 5 visits
 * - RELATIVE_FACTOR = 0.05 — 5% of the top-5 domain average; scales with activity
 * - AI chat sites always bypass the threshold
 * - Individual page titles with count < TITLE_MIN_COUNT are pruned for non-chat sites
 */
export function filterLowSignalDomains(formatted: string): string {
  const ABSOLUTE_MIN = 5;
  const RELATIVE_FACTOR = 0.05;
  const domainLineRegex = /^(\S+)\s+\((\d+)\)\s*$/;

  const domainCounts = new Map<string, number>();
  const sectionHeaders = [
    "### Most Active (Last 7 Days)",
    "### Long-term Interests (All-time, excluding recent)",
  ];

  for (const header of sectionHeaders) {
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = formatted.match(new RegExp(escaped + "\\s*\\n([\\s\\S]*?)(?=\\n###|\\n##|$)"));
    if (!match) continue;
    for (const line of match[1].split("\n")) {
      const m = line.trim().match(domainLineRegex);
      if (m) {
        const domain = m[1];
        const count = parseInt(m[2]);
        domainCounts.set(domain, Math.max(domainCounts.get(domain) ?? 0, count));
      }
    }
  }

  if (domainCounts.size === 0) return formatted;

  const allCounts = [...domainCounts.values()].sort((a, b) => b - a);
  const top5 = allCounts.slice(0, Math.min(5, allCounts.length));
  const top5Avg = top5.reduce((s, c) => s + c, 0) / top5.length;
  const threshold = Math.max(ABSOLUTE_MIN, Math.round(top5Avg * RELATIVE_FACTOR));

  const keepDomains = new Set<string>();
  const removedDomains: string[] = [];
  for (const [domain, count] of domainCounts) {
    if (count >= threshold || AI_CHAT_SITES.has(domain)) {
      keepDomains.add(domain);
    } else {
      removedDomains.push(`${domain} (${count})`);
    }
  }

  if (removedDomains.length > 0) {
    log(`Threshold: ${threshold} (top-5 avg: ${Math.round(top5Avg)})`);
    log(`Removed ${removedDomains.length} low-signal domains: ${removedDomains.join(", ")}`);
  }

  // Filter domain lines from summary sections
  let result = formatted;
  for (const header of sectionHeaders) {
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("(" + escaped + "\\s*\\n)([\\s\\S]*?)(?=\\n###|\\n##|$)");
    result = result.replace(regex, (_fullMatch, hdr: string, body: string) => {
      const filteredLines = body.split("\n").filter((line: string) => {
        const m = line.trim().match(domainLineRegex);
        if (!m) return true;
        return keepDomains.has(m[1]);
      });
      return hdr + filteredLines.join("\n");
    });
  }

  // Filter Content Details blocks and prune low-count titles
  const contentRegex = /(### Content Details\s*\n)([\s\S]*?)(?=\n## |$)/;
  const contentMatch = result.match(contentRegex);
  if (contentMatch) {
    const blocks = contentMatch[2].split(/\n(?=\*\*)/);
    const filteredBlocks = blocks
      .filter((block) => {
        const dm = block.match(/^\*\*(\S+?)\*\*/);
        if (!dm) return true;
        return keepDomains.has(dm[1]);
      })
      .map((block) => {
        const dm = block.match(/^\*\*(\S+?)\*\*/);
        if (!dm) return block;
        if (AI_CHAT_SITES.has(dm[1])) return block;

        const lines = block.split("\n");
        return lines
          .filter((line) => {
            const tm = line.match(/\((\d+)\)\s*$/);
            if (!tm) return true;
            return parseInt(tm[1]) >= TITLE_MIN_COUNT;
          })
          .join("\n");
      });

    result = result.replace(contentRegex, contentMatch[1] + filteredBlocks.join("\n"));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Signal Tiering
// ---------------------------------------------------------------------------

/** Tier 1: highest priority — active projects, browsing, shell history */
const TIER_1_HEADERS = ["Active Projects", "Browser Data", "Shell History"];

/** Tier 3: supplementary — apps and system signals */
const TIER_3_HEADERS = ["Apps", "System Signals"];

/**
 * Reorganize flat formatted signals into priority tiers.
 *
 * - Tier 1 (Core): Active Projects, Browser Data, Shell History
 * - Tier 2 (Supporting): Everything not in Tier 1 or 3
 * - Tier 3 (Supplementary): Apps, System Signals
 */
export function tierFormattedSignals(formatted: string): string {
  const sections: { header: string; content: string }[] = [];
  const parts = formatted.split(/\n(?=## )/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(/^## (.+)/);
    if (headerMatch) {
      sections.push({ header: headerMatch[1].trim(), content: trimmed });
    } else {
      sections.push({ header: "", content: trimmed });
    }
  }

  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];

  for (const section of sections) {
    if (TIER_1_HEADERS.some((h) => section.header.startsWith(h))) {
      tier1.push(section.content);
    } else if (TIER_3_HEADERS.some((h) => section.header.startsWith(h))) {
      tier3.push(section.content);
    } else {
      tier2.push(section.content);
    }
  }

  const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");
  const result: string[] = [];
  if (tier1.length > 0) result.push("# Tier 1: Core Signals (highest priority for synthesis)\n\n" + join(tier1));
  if (tier2.length > 0) result.push("# Tier 2: Supporting Context\n\n" + join(tier2));
  if (tier3.length > 0) result.push("# Tier 3: Supplementary\n\n" + join(tier3));

  return result.join("\n\n");
}
