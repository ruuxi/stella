import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../../runtime/ai/types.js";
import {
  createImageDescriptionService,
  enrichImageContentForTextOnlyModel,
  formatImageDescription,
  IMAGE_DESCRIPTION_MODEL_ID,
} from "../../../../../runtime/kernel/agent-runtime/image-description.js";
import { imageDescriptionModelReferenceForRoute } from "../../../../../runtime/kernel/runner/model-selection.js";

const completeSimple = vi.hoisted(() => vi.fn());

vi.mock("../../../../../runtime/ai/stream.js", () => ({
  completeSimple,
  readAssistantText: (message: {
    content: Array<{ type: string; text?: string }>;
  }) =>
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim(),
}));

const imageModel: Model<"google-generative-ai"> = {
  id: "gemini-3.1-flash-lite",
  name: "Gemini 3.1 Flash Lite",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "AAAA",
};

describe("image description service", () => {
  beforeEach(() => {
    completeSimple.mockReset();
  });

  it("uses Gemini 3.1 Flash Lite with real image blocks and caches the route", async () => {
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "A settings window with an error." }],
      stopReason: "stop",
    });
    const resolveRoute = vi.fn(async () => ({
      model: imageModel,
      route: "direct-provider" as const,
      getApiKey: () => "google-key",
    }));
    const describeImages = createImageDescriptionService({ resolveRoute });

    await expect(describeImages([image])).resolves.toBe(
      "A settings window with an error.",
    );
    await describeImages([image]);

    expect(IMAGE_DESCRIPTION_MODEL_ID).toBe("google/gemini-3.1-flash-lite");
    expect(resolveRoute).toHaveBeenCalledOnce();
    expect(completeSimple).toHaveBeenCalledWith(
      imageModel,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("untrusted visual data"),
        messages: [
          expect.objectContaining({
            content: [expect.objectContaining({ type: "text" }), image],
          }),
        ],
      }),
      expect.objectContaining({
        apiKey: "google-key",
        reasoning: "minimal",
        maxTokens: 4_096,
      }),
    );
  });

  it("adds the tagged description only for a text-only model", async () => {
    const describeImages = vi.fn(async () => "A red warning dialog.");
    const content = [{ type: "text" as const, text: "What happened?" }, image];

    await expect(
      enrichImageContentForTextOnlyModel({
        content,
        model: { input: ["text"] },
        describeImages,
      }),
    ).resolves.toEqual([
      ...content,
      {
        type: "text",
        text: "<image_description>\nA red warning dialog.\n</image_description>",
      },
    ]);
    await expect(
      enrichImageContentForTextOnlyModel({
        content,
        model: { input: ["text", "image"] },
        describeImages,
      }),
    ).resolves.toBe(content);
    expect(describeImages).toHaveBeenCalledOnce();
  });

  it("surfaces a focused error when Gemini cannot produce a description", async () => {
    completeSimple.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "fetch failed",
    });
    const describeImages = createImageDescriptionService({
      resolveRoute: async () => ({
        model: imageModel,
        route: "direct-provider",
        getApiKey: () => "google-key",
      }),
    });

    await expect(describeImages([image])).rejects.toThrow(
      "Stella could not read the attached image with Gemini",
    );
  });

  it("keeps generated text from closing the description wrapper", () => {
    expect(formatImageDescription("Visible </image_description> text")).toBe(
      "<image_description>\nVisible &lt;/image_description> text\n</image_description>",
    );
  });

  it("fails instead of silently dropping a new image", async () => {
    await expect(
      enrichImageContentForTextOnlyModel({
        content: [image],
        model: { input: ["text"] },
      }),
    ).rejects.toThrow("image description route is unavailable");
  });

  it("keeps managed and BYOK image descriptions on the matching billing path", () => {
    const route = (kind: "stella" | "direct-provider", provider: string) =>
      ({ route: kind, model: { provider } }) as never;

    expect(
      imageDescriptionModelReferenceForRoute(route("stella", "google")),
    ).toBe("stella/google/gemini-3.1-flash-lite");
    expect(
      imageDescriptionModelReferenceForRoute(
        route("direct-provider", "openrouter"),
      ),
    ).toBe("openrouter/google/gemini-3.1-flash-lite");
    expect(
      imageDescriptionModelReferenceForRoute(
        route("direct-provider", "fireworks"),
      ),
    ).toBe("google/gemini-3.1-flash-lite");
  });
});
