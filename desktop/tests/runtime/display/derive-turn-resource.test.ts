import { describe, expect, it } from "vitest";
import {
  buildPayloadFromBarePath,
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
  extractMarkdownLinkPaths,
} from "../../../src/features/chat/lib/derive-turn-resource";
import type { EventRecord } from "../../../src/features/chat/lib/event-transforms";

const event = (
  partial: Partial<EventRecord> &
    Pick<EventRecord, "_id" | "type" | "timestamp">,
): EventRecord => ({
  payload: {},
  ...partial,
});

const officeRef = (sourcePath: string) => ({
  sessionId: `session-${sourcePath}`,
  title: sourcePath.split("/").pop()!,
  sourcePath,
});

describe("deriveTurnResource", () => {
  it("returns null for empty turns", () => {
    expect(deriveTurnResource([])).toBeNull();
  });

  it("returns null when no tool emitted a fileChange and no message refs", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 1,
          payload: { toolName: "exec_command", result: "ok" },
        }),
      ]),
    ).toBeNull();
  });

  it("surfaces orchestrator apply_patch writes to ~/.stella/outputs/html/* as canvas-html", () => {
    // Delegated agents' html writes fold into their completion card instead
    // (see the mid-run leak tests below); the orchestrator's own writes to
    // the conventional output dir still surface as an inline canvas.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 7,
          payload: {
            toolName: "apply_patch",
            agentType: "orchestrator",
            result: "ok",
            fileChanges: [
              {
                path: "/Users/me/.stella/outputs/html/onboarding-options.html",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "canvas-html",
      filePath:
        "/Users/me/.stella/outputs/html/onboarding-options.html",
      title: "Onboarding Options",
      slug: "onboarding-options",
      createdAt: 7,
    });
  });

  it("ignores html files written outside ~/.stella/outputs/", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "apply_patch",
            agentType: "general",
            result: "ok",
            fileChanges: [
              {
                path: "/Users/me/projects/stella/desktop/index.html",
                kind: { type: "update" },
              },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("surfaces html reports written anywhere under ~/.stella/outputs/ as canvas-html", () => {
    // Not just `outputs/html/<slug>.html` — a report dropped straight into
    // the declared deliverables dir (e.g. `outputs/recall-report.html`) is a
    // user-facing document, not developer source, and must get a card.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 9,
          payload: {
            toolName: "exec_command",
            agentType: "orchestrator",
            result: "wrote report",
            producedFiles: [
              {
                path: "/Users/me/.stella/outputs/recall-blindspot-report.html",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "canvas-html",
      filePath: "/Users/me/.stella/outputs/recall-blindspot-report.html",
      title: "Recall Blindspot Report",
      slug: "recall-blindspot-report",
      createdAt: 9,
    });
  });

  it("surfaces html files in nested outputs subdirectories as canvas-html", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 4,
          payload: {
            toolName: "exec_command",
            agentType: "orchestrator",
            result: "ok",
            producedFiles: [
              {
                path: "/Users/me/.stella/outputs/stella-demos/demos-review.html",
                kind: { type: "update" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "canvas-html",
      filePath: "/Users/me/.stella/outputs/stella-demos/demos-review.html",
      title: "Demos Review",
      slug: "demos-review",
      createdAt: 4,
    });
  });

  it("drops profile/log noise from producedFiles and cards the real deliverable", () => {
    // Shell snapshot detection sweeps up incidental writes (launch logs,
    // browser profile state) alongside the actual output — those must never
    // become or block a card.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 11,
          payload: {
            toolName: "exec_command",
            result: "rendered video",
            producedFiles: [
              {
                path: "/Users/me/stella/.stella-launch.log",
                kind: { type: "update" },
              },
              {
                path: "/Users/me/.stella/outputs/demos/.brave-profile/Local State",
                kind: { type: "update" },
              },
              {
                path: "/Users/me/.stella/outputs/demos/demo1.mp4",
                kind: { type: "update" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "media",
      asset: {
        kind: "video",
        filePath: "/Users/me/.stella/outputs/demos/demo1.mp4",
      },
      createdAt: 11,
    });
  });

  it("returns null when producedFiles contain only noise", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 2,
          payload: {
            toolName: "exec_command",
            result: "ok",
            producedFiles: [
              {
                path: "/Users/me/stella/.stella-launch.log",
                kind: { type: "update" },
              },
              {
                path: "/Users/me/work/.cache/blob.bin",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("ranks ~/.stella/outputs/ deliverables above incidental produced files", () => {
    // Both are preferred-extension media, but the declared deliverable wins
    // the card even when the scratch file was detected first.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 6,
          payload: {
            toolName: "exec_command",
            result: "rendered",
            producedFiles: [
              {
                path: "/Users/me/worktree/demo/frames/f00074.jpg",
                kind: { type: "update" },
              },
              {
                path: "/Users/me/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "media",
      asset: {
        kind: "video",
        filePath: "/Users/me/.stella/outputs/demos/demo1.mp4",
      },
      createdAt: 6,
    });
  });

  it("prefers the orchestrator html tool result over a fileChange fallback", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 3,
          payload: {
            toolName: "html",
            agentType: "orchestrator",
            result: "Canvas saved",
            details: {
              filePath: "/.stella/outputs/html/plan.html",
              slug: "plan",
              title: "Plan",
              createdAt: 3,
            },
            fileChanges: [
              { path: "/.stella/outputs/html/plan.html", kind: { type: "add" } },
            ],
          },
        }),
      ]),
    ).toEqual({
      kind: "canvas-html",
      filePath: "/.stella/outputs/html/plan.html",
      title: "Plan",
      slug: "plan",
      createdAt: 3,
    });
  });

  it("derives a payload from a fileChanges record (Write add)", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "Write",
            result: "Created /out/report.pdf",
            fileChanges: [{ path: "/out/report.pdf", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({ kind: "pdf", filePath: "/out/report.pdf" });
  });

  it("derives a payload from producedFiles detected from shell output", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            result: "created report",
            producedFiles: [{ path: "/out/report.pdf", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({ kind: "pdf", filePath: "/out/report.pdf" });
  });

  it("surfaces shell-produced Office files as sidebar artifacts", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            result: "created deck",
            producedFiles: [{ path: "/out/deck.pptx", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({
      kind: "file-artifact",
      filePath: "/out/deck.pptx",
      artifactKind: "office-slides",
      title: "deck.pptx",
      createdAt: 5,
    });
  });

  it("surfaces unsupported shell-produced Office files as downloads", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            result: "created spreadsheet",
            producedFiles: [{ path: "/out/legacy.xls", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({
      kind: "media",
      asset: {
        kind: "download",
        filePath: "/out/legacy.xls",
        label: "legacy.xls",
      },
      createdAt: 5,
    });
  });

  it("does NOT surface agent-completed producedFiles as an inline canvas (they belong on the agent completion card)", () => {
    // Delegated-agent outputs ride `agent-completed` events; they must not
    // roll up into the orchestrator's inline artifact card (the jumpy pop).
    // They surface as pills on the agent's own completion card instead.
    expect(
      deriveTurnResource([
        event({
          _id: "agent-1",
          type: "agent-completed",
          timestamp: 9,
          payload: {
            agentId: "agent-1",
            agentType: "general",
            result: "...long report...",
            producedFiles: [
              {
                path: "/Users/me/.stella/outputs/html/q3-revenue-breakdown.html",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("does NOT derive an inline payload from subagent completed producedFiles", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "agent-1",
          type: "agent-completed",
          timestamp: 5,
          payload: {
            agentId: "agent-1",
            producedFiles: [{ path: "/out/chart.png", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("does NOT feed agent-completed fileChanges into collectTurnSourceDiffPayloads", () => {
    expect(
      collectTurnSourceDiffPayloads(
        [
          event({
            _id: "agent-1",
            type: "agent-completed",
            timestamp: 5,
            payload: {
              agentId: "agent-1",
              fileChanges: [
                { path: "/repo/src/main.ts", kind: { type: "update" } },
              ],
            },
          }),
        ],
        { developerResourcesEnabled: true },
      ),
    ).toEqual([]);
  });

  it("does NOT surface a delegated agent's MID-RUN tool_result files inline (loose-pill leak)", () => {
    // A subagent's own tool calls are forwarded into the conversation stream
    // as tool_result events stamped with the subagent's agentType (no
    // agentId). They must not pop standalone pills on the orchestrator's
    // row — the same files reach the agent-completed rollup and surface on
    // the agent's completion card.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            agentType: "general",
            result: "ok",
            producedFiles: [{ path: "/out/chart.png", kind: { type: "add" } }],
          },
        }),
        event({
          _id: "r2",
          type: "tool_result",
          timestamp: 6,
          payload: {
            toolName: "apply_patch",
            agentType: "my-custom-subagent",
            result: "ok",
            fileChanges: [{ path: "/out/report.pdf", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("does NOT surface a delegated agent's mid-run html output as an inline canvas", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 7,
          payload: {
            toolName: "apply_patch",
            agentType: "general",
            result: "ok",
            fileChanges: [
              {
                path: "/Users/me/.stella/outputs/html/mid-run-canvas.html",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("does NOT feed a delegated agent's mid-run fileChanges into collectTurnSourceDiffPayloads", () => {
    expect(
      collectTurnSourceDiffPayloads(
        [
          event({
            _id: "r1",
            type: "tool_result",
            timestamp: 5,
            payload: {
              toolName: "apply_patch",
              agentType: "general",
              result: "ok",
              fileChanges: [
                { path: "/repo/src/main.ts", kind: { type: "update" } },
              ],
            },
          }),
        ],
        { developerResourcesEnabled: true },
      ),
    ).toEqual([]);
  });

  it("keeps legacy tool_result events WITHOUT an agentType rendering inline (orchestrator-direct compat)", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            result: "ok",
            producedFiles: [{ path: "/out/chart.png", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/chart.png"] },
      createdAt: 5,
    });
  });

  it("still surfaces orchestrator-DIRECT tool_result producedFiles inline (unchanged)", () => {
    // The orchestrator ran the tool itself → files ride a `tool_result`
    // event and must keep rendering exactly as before.
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            agentType: "orchestrator",
            result: "ok",
            producedFiles: [{ path: "/out/chart.png", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/chart.png"] },
      createdAt: 5,
    });
  });

  it("uses move_path for renames (apply_patch update with Move to)", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "apply_patch",
            result: "ok",
            fileChanges: [
              {
                path: "/out/draft.txt",
                kind: { type: "update", move_path: "/out/final.pdf" },
              },
            ],
          },
        }),
      ]),
    ).toEqual({ kind: "pdf", filePath: "/out/final.pdf" });
  });

  it("ignores delete-only fileChanges", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "apply_patch",
            result: "ok",
            fileChanges: [{ path: "/out/old.pdf", kind: { type: "delete" } }],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("derives a media payload from image_gen results (rich metadata preserved)", () => {
    const result = deriveTurnResource([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          result: {
            jobId: "job-1",
            capability: "text_to_image",
            prompt: "a dog over Tokyo",
            filePaths: ["/.stella/media/outputs/job-1_0.png"],
          },
          fileChanges: [
            {
              path: "/.stella/media/outputs/job-1_0.png",
              kind: { type: "add" },
            },
          ],
        },
      }),
    ]);

    expect(result).toEqual({
      kind: "media",
      asset: {
        kind: "image",
        filePaths: ["/.stella/media/outputs/job-1_0.png"],
      },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a dog over Tokyo",
      createdAt: 100,
    });
  });

  it("does not surface orchestrator image_gen via deriveTurnResource", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "ig-1",
          type: "tool_result",
          timestamp: 100,
          payload: {
            toolName: "image_gen",
            agentType: "orchestrator",
            result: {
              jobId: "job-1",
              prompt: "a product mockup",
              filePaths: ["/.stella/media/outputs/job-1_0.png"],
            },
            fileChanges: [
              {
                path: "/.stella/media/outputs/job-1_0.png",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("preserves the full image set for multi-image image_gen turns", () => {
    const result = deriveTurnResource([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          result: {
            jobId: "job-1",
            capability: "text_to_image",
            prompt: "two options",
            filePaths: [
              "/.stella/media/outputs/job-1_0.png",
              "/.stella/media/outputs/job-1_1.png",
            ],
          },
          fileChanges: [
            {
              path: "/.stella/media/outputs/job-1_0.png",
              kind: { type: "add" },
            },
            {
              path: "/.stella/media/outputs/job-1_1.png",
              kind: { type: "add" },
            },
          ],
        },
      }),
    ]);

    expect(result).toEqual({
      kind: "media",
      asset: {
        kind: "image",
        filePaths: [
          "/.stella/media/outputs/job-1_0.png",
          "/.stella/media/outputs/job-1_1.png",
        ],
      },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "two options",
      createdAt: 100,
    });
  });

  it("derives an office payload from a tool result with officePreviewRef", () => {
    const ref = officeRef("/tmp/deck.pptx");
    expect(
      deriveTurnResource([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "exec_command",
            result: "Started preview",
            officePreviewRef: ref,
          },
        }),
      ]),
    ).toEqual({ kind: "office", previewRef: ref });
  });

  it("prioritizes a previewable extension when many paths were touched", () => {
    const ref = officeRef("/tmp/deck.pptx");
    const result = deriveTurnResource(
      [
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "Write",
            result: "Wrote /out/notes.md",
            fileChanges: [{ path: "/out/notes.md", kind: { type: "update" } }],
          },
        }),
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 2,
          payload: { toolName: "exec_command", officePreviewRef: ref },
        }),
      ],
      "Wrote some notes.",
    );
    expect(result).toEqual({ kind: "office", previewRef: ref });
  });

  it("returns null for an unsupported extension on a single fileChange", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "Write",
            fileChanges: [{ path: "/out/data.zip", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("surfaces markdown files without developer previews enabled", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "apply_patch",
            fileChanges: [{ path: "/out/notes.md", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toEqual({
      kind: "markdown",
      filePath: "/out/notes.md",
      title: "notes.md",
      createdAt: 1,
    });
  });

  it("omits developer files until developer previews are enabled", () => {
    const events = [
      event({
        _id: "w1",
        type: "tool_result",
        timestamp: 1,
        payload: {
          toolName: "apply_patch",
          fileChanges: [{ path: "/out/app.ts", kind: { type: "update" } }],
        },
      }),
    ];
    expect(deriveTurnResource(events)).toBeNull();
    expect(
      deriveTurnResource(events, "", undefined, {
        developerResourcesEnabled: true,
      }),
    ).toEqual({
      kind: "source-diff",
      filePath: "/out/app.ts",
      title: "app.ts",
      createdAt: 1,
    });
  });

  it("carries apply_patch input into developer diff payloads", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    expect(
      deriveTurnResource(
        [
          event({
            _id: "q1",
            type: "tool_request",
            timestamp: 1,
            requestId: "call-1",
            payload: { toolName: "apply_patch", args: { input: patch } },
          }),
          event({
            _id: "r1",
            type: "tool_result",
            timestamp: 2,
            requestId: "call-1",
            payload: {
              toolName: "apply_patch",
              fileChanges: [{ path: "/out/app.ts", kind: { type: "update" } }],
            },
          }),
        ],
        "",
        undefined,
        { developerResourcesEnabled: true },
      ),
    ).toEqual({
      kind: "source-diff",
      filePath: "/out/app.ts",
      title: "app.ts",
      patch,
      createdAt: 2,
    });
  });

  it("matches apply_patch input when tool_result stores requestId in payload", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    expect(
      deriveTurnResource(
        [
          event({
            _id: "q1",
            type: "tool_request",
            timestamp: 1,
            requestId: "call-1",
            payload: { toolName: "apply_patch", args: { input: patch } },
          }),
          event({
            _id: "r1",
            type: "tool_result",
            timestamp: 2,
            payload: {
              toolName: "apply_patch",
              requestId: "call-1",
              fileChanges: [{ path: "/out/app.ts", kind: { type: "update" } }],
            },
          }),
        ],
        "",
        undefined,
        { developerResourcesEnabled: true },
      ),
    ).toEqual({
      kind: "source-diff",
      filePath: "/out/app.ts",
      title: "app.ts",
      patch,
      createdAt: 2,
    });
  });

  it("falls back to a markdown-cited file when no tool emitted fileChanges", () => {
    expect(
      deriveTurnResource(
        [],
        "I wrote a report at [report.pdf](/Users/me/out/report.pdf).",
      ),
    ).toEqual({ kind: "pdf", filePath: "/Users/me/out/report.pdf" });
  });

  it("resolves relative markdown links against the turn cwd", () => {
    expect(
      deriveTurnResource(
        [],
        "I wrote a report at [report.pdf](./out/report.pdf).",
        "/Users/me/project",
      ),
    ).toEqual({
      kind: "pdf",
      filePath: "/Users/me/project/out/report.pdf",
    });
  });

  it("ignores http(s) markdown links", () => {
    expect(
      deriveTurnResource(
        [],
        "See [the docs](https://example.test/docs.pdf) for more.",
      ),
    ).toBeNull();
  });

  it("dedupes when an edited path also appears in a markdown link", () => {
    const result = deriveTurnResource(
      [
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "Write",
            fileChanges: [{ path: "/out/cover.png", kind: { type: "add" } }],
          },
        }),
      ],
      "Saved to [cover.png](./out/cover.png).",
      "/",
    );
    expect(result).toEqual({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/cover.png"] },
      createdAt: 5,
    });
  });

  it("does not surface a bare-path office file without a preview session", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "Write",
            fileChanges: [{ path: "/out/report.docx", kind: { type: "add" } }],
          },
        }),
      ]),
    ).toBeNull();
  });

  it("ignores malformed fileChanges payloads", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "w1",
          type: "tool_result",
          timestamp: 5,
          payload: {
            toolName: "Write",
            fileChanges: [
              { path: "", kind: { type: "add" } }, // empty path
              "not an object", // invalid entry
              { path: "/out/x.txt", kind: { type: "rename" } }, // unknown kind
            ],
          },
        }),
      ]),
    ).toBeNull();
  });
});

describe("deriveTurnInlineImagePayloads", () => {
  it("marks orchestrator image_gen results for inline image presentation", () => {
    const result = deriveTurnInlineImagePayloads([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: {
            jobId: "job-1",
            prompt: "a product mockup",
            filePaths: ["/.stella/media/outputs/job-1_0.png"],
          },
        },
      }),
    ]);

    expect(result).toEqual([
      {
        kind: "media",
        asset: {
          kind: "image",
          filePaths: ["/.stella/media/outputs/job-1_0.png"],
        },
        jobId: "job-1",
        prompt: "a product mockup",
        presentation: "inline-image",
        createdAt: 100,
      },
    ]);
  });

  it("creates a pending inline image payload for submitted orchestrator image_gen jobs", () => {
    const result = deriveTurnInlineImagePayloads([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: "image_gen job job-1 submitted.",
          details: {
            jobId: "job-1",
            capability: "text_to_image",
            prompt: "a product mockup",
            numImages: 3,
            status: "submitted",
          },
        },
      }),
    ]);

    expect(result).toEqual([
      {
        kind: "media",
        asset: { kind: "image", filePaths: [] },
        jobId: "job-1",
        capability: "text_to_image",
        prompt: "a product mockup",
        numImages: 3,
        presentation: "inline-image",
        createdAt: 100,
      },
    ]);
  });

  it("creates inline image payloads from voice-service-shaped image_gen results", () => {
    const result = deriveTurnInlineImagePayloads([
      event({
        _id: "ig-voice",
        type: "tool_result",
        timestamp: 120,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: {
            jobId: "job-voice",
            capability: "text_to_image",
            prompt: "voice generated scene",
            numImages: 2,
            status: "submitted",
          },
          details: {
            jobId: "job-voice",
            capability: "text_to_image",
            prompt: "voice generated scene",
            numImages: 2,
            status: "submitted",
          },
        },
      }),
    ]);

    expect(result).toEqual([
      {
        kind: "media",
        asset: { kind: "image", filePaths: [] },
        jobId: "job-voice",
        capability: "text_to_image",
        prompt: "voice generated scene",
        numImages: 2,
        presentation: "inline-image",
        createdAt: 120,
      },
    ]);
  });

  it("returns one payload per orchestrator image_gen call", () => {
    const result = deriveTurnInlineImagePayloads([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: "image_gen job job-1 submitted.",
          details: {
            jobId: "job-1",
            prompt: "first",
            status: "submitted",
          },
        },
      }),
      event({
        _id: "ig-2",
        type: "tool_result",
        timestamp: 110,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: "image_gen job job-2 submitted.",
          details: {
            jobId: "job-2",
            prompt: "second",
            status: "submitted",
          },
        },
      }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.jobId).toBe("job-1");
    expect(result[1]?.jobId).toBe("job-2");
  });

  it("preserves the full image set for multi-image orchestrator image_gen turns", () => {
    const result = deriveTurnInlineImagePayloads([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 100,
        payload: {
          toolName: "image_gen",
          agentType: "orchestrator",
          result: {
            jobId: "job-1",
            capability: "text_to_image",
            prompt: "two options",
            filePaths: [
              "/.stella/media/outputs/job-1_0.png",
              "/.stella/media/outputs/job-1_1.png",
            ],
          },
        },
      }),
    ]);

    expect(result).toEqual([
      {
        kind: "media",
        asset: {
          kind: "image",
          filePaths: [
            "/.stella/media/outputs/job-1_0.png",
            "/.stella/media/outputs/job-1_1.png",
          ],
        },
        jobId: "job-1",
        capability: "text_to_image",
        prompt: "two options",
        presentation: "inline-image",
        createdAt: 100,
      },
    ]);
  });
});

describe("collectTurnSourceDiffPayloads", () => {
  it("returns [] when developer previews are off", () => {
    expect(
      collectTurnSourceDiffPayloads([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "apply_patch",
            fileChanges: [{ path: "/x/a.ts", kind: { type: "update" } }],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("returns [] for empty tool events", () => {
    expect(
      collectTurnSourceDiffPayloads([], {
        developerResourcesEnabled: true,
      }),
    ).toEqual([]);
  });

  it("only emits payloads for developer-resource extensions", () => {
    const result = collectTurnSourceDiffPayloads(
      [
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "apply_patch",
            fileChanges: [
              { path: "/x/a.ts", kind: { type: "update" } },
              { path: "/x/b.png", kind: { type: "update" } },
              { path: "/x/c.py", kind: { type: "add" } },
            ],
          },
        }),
      ],
      { developerResourcesEnabled: true },
    );
    expect(result.map((p) => p.kind === "source-diff" && p.filePath)).toEqual([
      "/x/a.ts",
      "/x/c.py",
    ]);
  });

  it("dedupes by absolute path across multiple tool results", () => {
    const result = collectTurnSourceDiffPayloads(
      [
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "Write",
            fileChanges: [{ path: "/x/a.ts", kind: { type: "add" } }],
          },
        }),
        event({
          _id: "r2",
          type: "tool_result",
          timestamp: 2,
          payload: {
            toolName: "Edit",
            fileChanges: [{ path: "/x/a.ts", kind: { type: "update" } }],
          },
        }),
      ],
      { developerResourcesEnabled: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind === "source-diff" && result[0]!.filePath).toBe(
      "/x/a.ts",
    );
  });

  it("attaches apply_patch input to the matching payload only", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const result = collectTurnSourceDiffPayloads(
      [
        event({
          _id: "q1",
          type: "tool_request",
          timestamp: 1,
          requestId: "call-1",
          payload: { toolName: "apply_patch", args: { input: patch } },
        }),
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 2,
          requestId: "call-1",
          payload: {
            toolName: "apply_patch",
            fileChanges: [{ path: "/x/a.ts", kind: { type: "update" } }],
          },
        }),
        event({
          _id: "r2",
          type: "tool_result",
          timestamp: 3,
          payload: {
            toolName: "Write",
            fileChanges: [{ path: "/x/b.ts", kind: { type: "add" } }],
          },
        }),
      ],
      { developerResourcesEnabled: true },
    );
    expect(result).toHaveLength(2);
    const byPath = new Map(
      result
        .filter((p) => p.kind === "source-diff")
        .map((p) => [
          p.kind === "source-diff" ? p.filePath : "",
          p.kind === "source-diff" ? p.patch : undefined,
        ]),
    );
    expect(byPath.get("/x/a.ts")).toBe(patch);
    expect(byPath.get("/x/b.ts")).toBeUndefined();
  });

  it("skips deleted files (no post-mutation path)", () => {
    const result = collectTurnSourceDiffPayloads(
      [
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "apply_patch",
            fileChanges: [{ path: "/x/a.ts", kind: { type: "delete" } }],
          },
        }),
      ],
      { developerResourcesEnabled: true },
    );
    expect(result).toEqual([]);
  });
});

describe("extractMarkdownLinkPaths", () => {
  it("returns [] for empty input", () => {
    expect(extractMarkdownLinkPaths("")).toEqual([]);
  });

  it("extracts standard markdown links", () => {
    expect(
      extractMarkdownLinkPaths(
        "Look at [report](/out/report.pdf) and [notes](./notes.md).",
      ),
    ).toEqual(["/out/report.pdf", "./notes.md"]);
  });

  it("supports angle-bracket wrapped urls", () => {
    expect(
      extractMarkdownLinkPaths("File: [name](</tmp/with space.pdf>)."),
    ).toEqual(["/tmp/with space.pdf"]);
  });

  it("decodes percent-encoded path components", () => {
    expect(extractMarkdownLinkPaths("[x](/tmp/with%20space.pdf)")).toEqual([
      "/tmp/with space.pdf",
    ]);
  });

  it("filters out http(s), mailto, and protocol-relative urls", () => {
    expect(
      extractMarkdownLinkPaths(
        [
          "[a](https://example.test/a)",
          "[b](http://example.test/b)",
          "[c](mailto:foo@example.test)",
          "[d](//example.test/d)",
          "[e](/local.pdf)",
        ].join(" "),
      ),
    ).toEqual(["/local.pdf"]);
  });
});

describe("buildPayloadFromBarePath", () => {
  it("recognizes ~/.stella/outputs/html/<slug>.html as a canvas-html payload", () => {
    expect(
      buildPayloadFromBarePath(
        "/Users/me/.stella/outputs/html/plan-options.html",
        42,
      ),
    ).toEqual({
      kind: "canvas-html",
      filePath:
        "/Users/me/.stella/outputs/html/plan-options.html",
      title: "Plan Options",
      slug: "plan-options",
      createdAt: 42,
    });
  });

  it("does not turn unrelated .html files into canvas payloads", () => {
    expect(
      buildPayloadFromBarePath("/Users/me/projects/stella/desktop/index.html", 1),
    ).toBeNull();
  });
});
