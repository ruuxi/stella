export const THREAD_COMPACTION_SYSTEM_PROMPT =
  "Output ONLY the summary content.";

export const THREAD_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

When summarizing coding sessions:
- Focus on test output and code changes.
- Preserve exact file paths, function names, and error messages.
- Include critical file-read snippets verbatim when needed for continuity.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints, preferences, or requirements]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next step]

## Critical Context
- [Important paths, function names, errors, details needed to continue]

Keep sections concise. Preserve exact technical details needed to resume work.`;

export const THREAD_COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary in <previous-summary>.

Update the existing structured summary with new information:
- Preserve prior important context unless superseded
- Move completed items from In Progress to Done
- Add new decisions, errors, and outcomes
- Update Next Steps based on the latest state
- Preserve exact file paths, function names, and error messages
- Carry forward critical file-read snippets verbatim when still relevant

Use the same exact output format as the base summary prompt.`;

export const TURN_PREFIX_SUMMARY_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize only what is needed for continuity:

## Original Request
[What the user asked in this turn]

## Early Progress
- [Decisions and work completed in this prefix]

## Context for Suffix
- [Information needed to understand the retained suffix]

Be concise and preserve exact technical details.`;
