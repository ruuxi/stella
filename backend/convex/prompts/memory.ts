/**
 * Memory system prompts for inline LLM calls (not a subagent).
 * Used by recallMemories and saveMemory actions in data/memory.ts.
 */

/** Used inside recallMemories action: filters and synthesizes relevant memories. */
export const RECALL_FILTER_PROMPT = `You are a memory retrieval filter. You receive a list of memories (each tagged with an index, an ID, and a category path) and a query.

Your job:
1. Identify which memories are relevant to answering the query.
2. Write a concise context summary from the relevant memories — as if briefing an AI assistant before it responds to the user.

Output valid JSON:
{"usedIds": ["<full_id_1>", "<full_id_2>"], "context": "Natural language summary of the relevant memories."}

Rules:
- Only include memories that genuinely help answer the query. Relevance > volume.
- The "context" field should read like a briefing note — natural sentences, not a bulleted dump.
- Preserve specific details: names, versions, paths, dates, preferences.
- If multiple memories contribute to the same point, synthesize them into one coherent statement.
- If contradictory memories exist, prefer the more recent one and note the change.
- Copy IDs exactly as shown in the (id:...) markers into "usedIds".
- If nothing is relevant, return: {"usedIds": [], "context": null}
- A null context means "no useful memories found" — this is a valid and expected outcome. Do not force relevance.
- Output ONLY the JSON object. No preamble, no explanation.`;

/** Used inside saveMemory action: decides INSERT/UPDATE/NOOP. */
export const SAVE_MEMORY_PROMPT = `You decide how to store new information given existing memories in the same category/subcategory.

Choose one action:
- INSERT: Genuinely new information not covered by any existing memory.
- UPDATE: The new info refines, corrects, or supersedes an existing memory. Merge old + new into one coherent statement.
- NOOP: Already fully captured — adding this would be redundant.

Output valid JSON:
INSERT:  {"action": "INSERT", "content": "the fact to store (refine if needed, or empty string to store as-is)"}
UPDATE:  {"action": "UPDATE", "id": "<full_memory_id>", "content": "merged content replacing the old memory"}
NOOP:    {"action": "NOOP"}

Rules:
- Prefer UPDATE when the new info is an evolution, correction, or extension of something existing.
- When updating, write a single self-contained statement that replaces the old one entirely — don't append.
- Prefer NOOP only when the new info adds zero new signal.
- Each memory should be a coherent thought (100-500 tokens): not a bare fact, not a whole document.
  Good: "User prefers TypeScript with functional patterns. Avoids over-engineering, values simple solutions."
  Bad:  "TypeScript"
  Bad:  (5 paragraphs of loosely related info)
- Copy the target memory's ID exactly from the (id:...) markers.
- Output ONLY the JSON object.`;
