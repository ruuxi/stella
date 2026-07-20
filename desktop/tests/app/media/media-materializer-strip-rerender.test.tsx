// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
}));

vi.mock("@/shared/hooks/use-display-file-data", () => ({
  useDisplayFileBlobs: (paths: string[]) => ({
    files: paths.map((filePath) => ({
      path: filePath,
      url: `file://${filePath}`,
    })),
    error: null,
    loading: false,
  }),
}));

vi.mock("@/features/workspace-display/open-payload", () => ({
  openDisplayPayloadTab: vi.fn(),
}));

vi.mock("@/shell/chat-scroll-follow", () => ({
  notifyAssistantScrollFollowLayoutChange: vi.fn(),
}));

describe("materialized image strip publication", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    storage.clear();
    document.documentElement.dataset.stellaWindow = "mini";
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.documentElement.dataset.stellaWindow;
  });

  it("rerenders the pending strip when the shared Map gains a payload", async () => {
    const { InlineGeneratedImageStrip } = await import(
      "../../../src/app/chat/InlineGeneratedImageCard.js"
    );
    const { publishMaterializedMediaPayload } = await import(
      "../../../src/app/media/media-materializer-state.js"
    );
    const pending = ["job-react-a", "job-react-b"].map((jobId, index) => ({
      kind: "media" as const,
      asset: { kind: "image" as const, filePaths: [] },
      jobId,
      capability: "text_to_image",
      prompt: `image ${index}`,
      createdAt: index + 1,
      numImages: 1,
    }));

    await act(async () => {
      root.render(<InlineGeneratedImageStrip payloads={pending} />);
    });
    const strip = container.querySelector('[aria-label="Generated images"]');
    expect(strip?.getAttribute("aria-busy")).toBe("true");
    expect(strip?.textContent).toContain("Generating...");

    await act(async () => {
      publishMaterializedMediaPayload({
        ...pending[0],
        asset: { kind: "image", filePaths: ["/tmp/job-react-a.png"] },
      });
    });

    expect(strip?.hasAttribute("aria-busy")).toBe(false);
    expect(strip?.textContent).not.toContain("Generating...");
    expect(
      container.querySelector('img[src="file:///tmp/job-react-a.png"]'),
    ).not.toBeNull();
  });
});
