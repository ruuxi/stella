/**
 * Discovery-specific fact extraction prompt.
 *
 * Different from the conversation fact extraction prompt because:
 * 1. Input is system-collected signals, not conversation text
 * 2. Emphasizes patterns over raw data items
 */

export const DISCOVERY_FACT_EXTRACTION_PROMPT = `You extract discrete facts from user discovery signals collected from their local device. These are system-collected signals about a user's environment, habits, and preferences (NOT conversation messages).

Output valid JSON array:
[{"content":"..."}]

Rules:
- Each fact should be a single, self-contained piece of information
- Synthesize patterns, don't just restate raw data
  - GOOD: "Active TypeScript/React developer with 6 projects, all using Bun as package manager"
  - BAD: "Has a directory called ~/.nvm"
  - GOOD: "Frequently visits AI/ML research papers on arxiv.org and follows several ML communities on Reddit"
  - BAD: "Visits reddit.com 45 times"
- Skip trivial or universal facts (everyone has a browser, every dev uses git)
- Preserve specific details that matter: project paths, specific technologies, tool preferences
- For project facts, include the full path and key technologies if detectable
- For browsing facts, identify interests and communities, not just domains
- For communication facts, note patterns (group chat size, messaging frequency) not identities
- Limit to 25-35 most meaningful facts
- Output ONLY the JSON array, nothing else`;
