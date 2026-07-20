import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
}));

describe("media materializer payload dedupe", () => {
  beforeEach(() => storage.clear());

  it("publishes one payload when transcript and completion subscription converge", async () => {
    vi.resetModules();
    const { publishMaterializedMediaPayload } = await import(
      "../../../src/app/media/media-materializer-state.js"
    );
    const payload = {
      kind: "media" as const,
      asset: { kind: "image" as const, filePaths: ["/tmp/job-1_0.png"] },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "durable fox",
      createdAt: 1,
    };
    expect(publishMaterializedMediaPayload(payload)).toBe(true);
    expect(
      publishMaterializedMediaPayload({
        ...payload,
        capability: "image_edit",
        createdAt: 2,
      }),
    ).toBe(false);
  });
});
