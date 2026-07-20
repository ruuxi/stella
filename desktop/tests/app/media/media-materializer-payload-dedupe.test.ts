import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
}));

describe("media materializer payload dedupe", () => {
  beforeEach(() => storage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("publishes one payload when transcript and completion subscription converge", async () => {
    vi.resetModules();
    const { publishMaterializedMediaPayload } =
      await import("../../../src/app/media/media-materializer-state.js");
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

  it("uses provider MIME metadata for the renderer artifact extension", async () => {
    vi.resetModules();
    const saveOutput = vi.fn(async (_url: string, fileName: string) => ({
      ok: true,
      path: `/tmp/${fileName}`,
    }));
    vi.stubGlobal("window", {
      electronAPI: { media: { saveOutput } },
    });
    const { extractOutput, saveOutputToStella } =
      await import("../../../src/app/media/media-store.js");
    const output = extractOutput({
      images: [
        {
          url: "https://example.test/artifact-without-extension",
          content_type: "image/jpeg",
        },
      ],
    });
    await saveOutputToStella(output, "mime-job");
    expect(saveOutput).toHaveBeenCalledWith(
      "https://example.test/artifact-without-extension",
      "mime-job_0.jpg",
    );
  });
});
