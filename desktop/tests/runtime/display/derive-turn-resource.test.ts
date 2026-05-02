import { describe, expect, it } from "vitest";
import {
  deriveTurnResource,
  extractMarkdownLinkPaths,
} from "../../../src/app/chat/lib/derive-turn-resource";
import type { EventRecord } from "../../../src/app/chat/lib/event-transforms";

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

  it("surfaces Display canvas calls as inline chat resources", () => {
    expect(
      deriveTurnResource([
        event({
          _id: "q1",
          type: "tool_request",
          requestId: "display-1",
          timestamp: 4,
          payload: {
            toolName: "Display",
            args: {
              i_have_read_guidelines: true,
              html: "<div><canvas id=\"chart\"></canvas><script>window.ok = true</script></div>",
            },
          },
        }),
        event({
          _id: "r1",
          type: "tool_result",
          requestId: "display-1",
          timestamp: 5,
          payload: { toolName: "Display", result: "Display updated." },
        }),
      ]),
    ).toEqual({
      kind: "html",
      html: "<div><canvas id=\"chart\"></canvas><script>window.ok = true</script></div>",
      title: "Canvas",
      createdAt: 5,
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

  it("derives a payload from subagent completed producedFiles", () => {
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
            filePaths: ["/state/media/outputs/job-1_0.png"],
          },
          fileChanges: [
            {
              path: "/state/media/outputs/job-1_0.png",
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
        filePaths: ["/state/media/outputs/job-1_0.png"],
      },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a dog over Tokyo",
      createdAt: 100,
    });
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
              "/state/media/outputs/job-1_0.png",
              "/state/media/outputs/job-1_1.png",
            ],
          },
          fileChanges: [
            {
              path: "/state/media/outputs/job-1_0.png",
              kind: { type: "add" },
            },
            {
              path: "/state/media/outputs/job-1_1.png",
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
          "/state/media/outputs/job-1_0.png",
          "/state/media/outputs/job-1_1.png",
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
