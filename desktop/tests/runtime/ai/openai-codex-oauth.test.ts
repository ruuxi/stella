import { describe, expect, it } from "vitest";
import { loginOpenAICodex } from "../../../../runtime/ai/utils/oauth/openai-codex.js";

describe("OpenAI Codex OAuth callback lifecycle", () => {
  it("settles a provider denial and releases the callback server", async () => {
    const login = loginOpenAICodex({
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        void fetch(
          `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&error=access_denied&error_description=User%20declined`,
        );
      },
      onPrompt: async () => "",
    });

    await expect(login).rejects.toThrow("User declined");
  });

  it("cancels an in-flight callback wait and releases the port", async () => {
    const controller = new AbortController();
    const login = loginOpenAICodex({
      signal: controller.signal,
      onAuth: () => controller.abort(),
      onPrompt: async () => "",
    });

    await expect(login).rejects.toThrow("canceled");
  });
});
