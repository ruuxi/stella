import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import {
  buildKnownMemoryContext,
  buildMemoryReviewSystemPrompt,
  buildMemoryReviewTranscript,
  buildMemoryReviewUserPrompt,
  maxMessageTimestamp,
  parseMemoryReviewCandidate,
  sliceMessagesSinceReview,
} from "../../../../../runtime/kernel/agent-runtime/memory-review.js";
import {
  ORCHESTRATOR_REVIEW_MEMORY_EXTENSION,
  orchestratorReviewNotesDir,
  writeOrchestratorReviewMemoryNote,
} from "../../../../../runtime/kernel/memory/orchestrator-review-notes.js";

type TestContext = {
  rootPath: string;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-memory-review-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const context = { rootPath };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("buildMemoryReviewSystemPrompt", () => {
  it("gates on conversational continuity and excludes restating agent work", () => {
    const prompt = buildMemoryReviewSystemPrompt();

    expect(prompt).toContain("would the user be surprised Stella forgot this?");
    expect(prompt).toContain("working on, planning, or thinking through");
    expect(prompt).toContain("never restate agent task results here");
    expect(prompt).toContain("Output JSON only");
  });
});

describe("buildMemoryReviewTranscript", () => {
  it("keeps Orchestrator user and assistant text while dropping tool outputs", () => {
    const transcript = buildMemoryReviewTranscript([
      {
        role: "user",
        content: "remember that I want terse release reports",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Got it." }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "spawn_agent",
        content: [{ type: "text", text: "Agent completed with secret details" }],
        isError: false,
        timestamp: 3,
      },
    ] as AgentMessage[]);

    expect(transcript).toContain("[User]");
    expect(transcript).toContain("terse release reports");
    expect(transcript).toContain("[Assistant]");
    expect(transcript).toContain("Got it.");
    expect(transcript).not.toContain("Agent completed");
    expect(transcript).not.toContain("secret details");
  });
});

describe("sliceMessagesSinceReview", () => {
  const snapshot: AgentMessage[] = [
    { role: "user", content: "first ask", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: 110 },
    { role: "user", content: "second ask", timestamp: 200 },
    { role: "assistant", content: [{ type: "text", text: "second reply" }], timestamp: 210 },
  ] as AgentMessage[];

  it("returns the whole snapshot when there is no prior watermark", () => {
    expect(sliceMessagesSinceReview(snapshot, 0)).toHaveLength(4);
  });

  it("keeps only messages newer than the watermark", () => {
    const windowed = sliceMessagesSinceReview(snapshot, 110);
    expect(windowed.map((m) => m.timestamp)).toEqual([200, 210]);
  });

  it("drops compaction checkpoint/summary messages so they are not reviewed as fresh signal", () => {
    const withCheckpoint: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[[THREAD_CHECKPOINT]]\n\n## Topic\nEarlier work folded into a summary.",
          },
        ],
        timestamp: 150,
      },
      { role: "user", content: "new ask after compaction", timestamp: 160 },
    ] as AgentMessage[];

    const windowed = sliceMessagesSinceReview(withCheckpoint, 0);
    const transcript = buildMemoryReviewTranscript(windowed);
    expect(transcript).not.toContain("THREAD_CHECKPOINT");
    expect(transcript).not.toContain("folded into a summary");
    expect(transcript).toContain("new ask after compaction");
  });
});

describe("maxMessageTimestamp", () => {
  it("returns the newest timestamp, or 0 when none are present", () => {
    expect(
      maxMessageTimestamp([
        { role: "user", content: "a", timestamp: 5 },
        { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 42 },
      ] as AgentMessage[]),
    ).toBe(42);
    expect(maxMessageTimestamp([])).toBe(0);
  });
});

describe("parseMemoryReviewCandidate", () => {
  it("returns null when the model says nothing is worth saving", () => {
    expect(
      parseMemoryReviewCandidate(
        '{"shouldWrite":false,"reason":"one-off task detail"}',
      ),
    ).toBeNull();
  });

  it("parses a valid candidate from fenced JSON", () => {
    const candidate = parseMemoryReviewCandidate(`\`\`\`json
{"shouldWrite":true,"title":"Read-only constraints","category":"user_preference","memory":"The user treats 'do not make changes' as a hard read-only constraint.","recallHooks":["do not make changes","read only"],"evidence":["User said: do not make changes"]}
\`\`\``);

    expect(candidate).toEqual({
      title: "Read-only constraints",
      category: "user_preference",
      memory: "The user treats 'do not make changes' as a hard read-only constraint.",
      recallHooks: ["do not make changes", "read only"],
      evidence: ["User said: do not make changes"],
    });
  });
});

describe("buildMemoryReviewUserPrompt", () => {
  it("omits the Known Memory section when none is provided", () => {
    const prompt = buildMemoryReviewUserPrompt("[User]\nhello");
    expect(prompt).not.toContain("# Known Memory");
    expect(prompt).toContain("[User]\nhello");
  });

  it("includes the Known Memory section with a do-not-duplicate cue", () => {
    const prompt = buildMemoryReviewUserPrompt(
      "[User]\nhello",
      "<consolidated_memory>existing fact</consolidated_memory>",
    );
    expect(prompt).toContain("# Known Memory");
    expect(prompt).toContain("Do not propose anything already covered here.");
    expect(prompt).toContain("existing fact");
    expect(prompt).toContain("[User]\nhello");
  });
});

describe("buildKnownMemoryContext", () => {
  it("returns an empty string when no memory exists yet", async () => {
    const { rootPath } = createTestContext();
    expect(await buildKnownMemoryContext(rootPath)).toBe("");
  });

  it("combines the consolidated summary with recent candidate notes", async () => {
    const { rootPath } = createTestContext();
    await mkdir(path.join(rootPath, "memories"), { recursive: true });
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "- User prefers terse summaries.\n",
      "utf-8",
    );
    await writeOrchestratorReviewMemoryNote({
      stellaHome: rootPath,
      note: {
        title: "Dark mode default",
        category: "user_preference",
        memory: "The user wants dark mode as the default theme.",
        recallHooks: ["dark mode", "theme"],
        evidence: ["User said: remember I want dark mode"],
      },
    });

    const context = await buildKnownMemoryContext(rootPath);
    expect(context).toContain("consolidated_memory");
    expect(context).toContain("terse summaries");
    expect(context).toContain("recent_candidates");
    expect(context).toContain("dark mode as the default theme");
  });
});

describe("writeOrchestratorReviewMemoryNote", () => {
  it("writes a Dream extension note and instructions file", async () => {
    const { rootPath } = createTestContext();

    const result = await writeOrchestratorReviewMemoryNote({
      stellaHome: rootPath,
      note: {
        title: "Read-only constraints",
        category: "user_preference",
        memory: "Treat 'just investigate' as read-only unless the user later asks to implement.",
        recallHooks: ["just investigate", "read-only"],
        evidence: ["User corrected the agent after an unwanted implementation."],
        createdAt: new Date("2026-05-28T12:00:00.000Z"),
      },
    });

    expect(result.extension).toBe(ORCHESTRATOR_REVIEW_MEMORY_EXTENSION);
    const files = await readdir(orchestratorReviewNotesDir(rootPath));
    expect(files).toEqual(["2026-05-28T12-00-00-read-only-constraints.md"]);

    const note = await readFile(result.path, "utf-8");
    expect(note).toContain("# Orchestrator review memory candidate");
    expect(note).toContain("Treat 'just investigate' as read-only");
    expect(note).toContain("## Recall hooks");

    const instructions = await readFile(
      path.join(
        rootPath,
        "memories_extensions",
        "orchestrator_review",
        "instructions.md",
      ),
      "utf-8",
    );
    expect(instructions).toContain(
      "the user would expect Stella to recall it in a later conversation",
    );
  });
});
