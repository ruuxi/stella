import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAICodex } from "../../../../runtime/ai/utils/oauth/openai-codex.js";

describe("OpenAI Codex OAuth callback lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it("aborts an in-flight token exchange before credentials can resolve", async () => {
    const nativeFetch = globalThis.fetch;
    let markTokenStarted!: () => void;
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/oauth/token")) {
          markTokenStarted();
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectAbort = () =>
              reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        return nativeFetch(input, init);
      }),
    );

    const controller = new AbortController();
    const login = loginOpenAICodex({
      signal: controller.signal,
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        void nativeFetch(
          `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&code=test-code`,
        );
      },
      onPrompt: async () => "",
    });

    await tokenStarted;
    controller.abort();
    await expect(login).rejects.toThrow("canceled");
  });
});
