import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import {
  buildKnownMemoryContext,
  buildMemoryReviewTranscript,
  buildMemoryReviewUserPrompt,
  maxMessageTimestamp,
  parseMemoryReviewCandidate,
  sliceMessagesSinceReview,
} from "../../../../../runtime/kernel/agent-runtime/memory-review.js";
import { DreamInboxStore } from "../../../../../runtime/kernel/memory/dream-inbox-store.js";
import type { RuntimeStore } from "../../../../../runtime/kernel/storage/runtime-store.js";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-memory-review-prompt",
  (db) => new DreamInboxStore(db),
);
const createTestContext = testContexts.create;
const asRuntimeStore = (store: DreamInboxStore): RuntimeStore =>
  ({ dreamInboxStore: store }) as unknown as RuntimeStore;

afterEach(() => testContexts.cleanup());

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
        content: [
          { type: "text", text: "Agent completed with secret details" },
        ],
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

  it("redacts secret-like values before building the model transcript", () => {
    const transcript = buildMemoryReviewTranscript([
      {
        role: "user",
        content: "remember OPENAI_API_KEY=sk-testsecret12345678901234567890",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Noted bearer token Authorization: Bearer sk-testsecret12345678901234567890",
          },
        ],
        timestamp: 2,
      },
    ] as AgentMessage[]);

    expect(transcript).not.toContain("sk-testsecret12345678901234567890");
    expect(transcript).toContain("OPENAI_API_KEY=");
    expect(transcript).toContain("***");
  });
});

describe("sliceMessagesSinceReview", () => {
  const snapshot: AgentMessage[] = [
    { role: "user", content: "first ask", timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "text", text: "first reply" }],
      timestamp: 110,
    },
    { role: "user", content: "second ask", timestamp: 200 },
    {
      role: "assistant",
      content: [{ type: "text", text: "second reply" }],
      timestamp: 210,
    },
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
        {
          role: "assistant",
          content: [{ type: "text", text: "b" }],
          timestamp: 42,
        },
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
      memory:
        "The user treats 'do not make changes' as a hard read-only constraint.",
      recallHooks: ["do not make changes", "read only"],
      evidence: ["User said: do not make changes"],
    });
  });

  it("redacts secrets from parsed candidates before they can be written", () => {
    const candidate = parseMemoryReviewCandidate(
      '{"shouldWrite":true,"title":"API key","category":"active_focus","memory":"User pasted OPENAI_API_KEY=sk-testsecret12345678901234567890","recallHooks":["sk-testsecret12345678901234567890"],"evidence":["Authorization: Bearer sk-testsecret12345678901234567890"]}',
    );

    expect(JSON.stringify(candidate)).not.toContain(
      "sk-testsecret12345678901234567890",
    );
    expect(candidate?.memory).toContain("OPENAI_API_KEY=");
    expect(candidate?.memory).toContain("***");
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
    const { rootPath, store } = createTestContext();
    expect(
      await buildKnownMemoryContext({
        stellaDataDir: rootPath,
        store: asRuntimeStore(store),
      }),
    ).toBe("");
  });

  it("combines the consolidated summary with recent candidate notes", async () => {
    const { rootPath, store } = createTestContext();
    await mkdir(path.join(rootPath, "memories"), { recursive: true });
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "- User prefers terse summaries.\n",
      "utf-8",
    );
    store.recordMemoryNote({
      title: "Dark mode default",
      category: "user_preference",
      memory: "The user wants dark mode as the default theme.",
      recallHooks: ["dark mode", "theme"],
      evidence: ["User said: remember I want dark mode"],
    });

    const context = await buildKnownMemoryContext({
      stellaDataDir: rootPath,
      store: asRuntimeStore(store),
    });
    expect(context).toContain("consolidated_memory");
    expect(context).toContain("terse summaries");
    expect(context).toContain("recent_candidates");
    expect(context).toContain("dark mode as the default theme");
  });

  it("redacts existing known memory before feeding it into review", async () => {
    const { rootPath, store } = createTestContext();
    await mkdir(path.join(rootPath, "memories"), { recursive: true });
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "- OPENAI_API_KEY=sk-testsecret12345678901234567890\n",
      "utf-8",
    );
    store.recordMemoryNote({
      title: "Already redacted",
      category: "active_focus",
      memory: "Authorization: Bearer sk-testsecret12345678901234567890",
      recallHooks: ["token"],
      evidence: ["token"],
    });

    const context = await buildKnownMemoryContext({
      stellaDataDir: rootPath,
      store: asRuntimeStore(store),
    });
    expect(context).not.toContain("sk-testsecret12345678901234567890");
    expect(context).toContain("OPENAI_API_KEY=");
    expect(context).toContain("***");
  });
});
