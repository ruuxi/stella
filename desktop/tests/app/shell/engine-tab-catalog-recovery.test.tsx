// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeModelCatalogSnapshot } from "../../../../runtime/protocol/index";

vi.mock("@/global/auth/services/auth-session", () => ({
  useDesktopAuthSession: () => ({ isPending: false, data: null }),
  getAuthSessionSnapshot: () => ({ isPending: false, data: null }),
}));

vi.mock("@/global/settings/hooks/model-catalog-updated-at", () => ({
  useModelCatalogUpdatedAt: () => null,
  readModelCatalogUpdatedAtSnapshot: () => null,
}));

vi.mock("@/shared/lib/use-convex-one-shot", () => ({
  usePersistentConvexOneShot: () => undefined,
}));

vi.mock("@/platform/http/service-request", () => ({
  createServiceRequest: vi.fn(async () => ({
    endpoint: "https://catalog.test/api/models",
    headers: {},
  })),
}));

vi.mock("@/global/settings/hooks/use-llm-credentials", () => ({
  useLlmCredentials: () => ({
    validateOAuth: vi.fn(async () => ({ connected: true, needsReauth: false })),
    loginOAuth: vi.fn(async () => {}),
    cancelOAuth: vi.fn(async () => {}),
    loading: false,
  }),
}));

vi.mock("@/global/settings/EnginePickerPill", () => ({
  EnginePickerPill: () => null,
}));
vi.mock("@/global/settings/ProviderModelPanel", () => ({
  ProviderModelPanel: () => null,
}));
vi.mock("@/global/settings/ProviderOnlyPicker", () => ({
  ProviderOnlyPicker: () => null,
}));
vi.mock("@/global/settings/VoiceProviderPicker", () => ({
  VoiceProviderPicker: () => null,
}));
vi.mock("@/global/billing/audience", () => ({
  resolveBillingAudience: () => null,
  getPlanLabel: () => "",
  isRestrictedModelOverrideAudience: () => false,
}));
vi.mock("@/ui/icons", () => ({
  Lightbulb: () => null,
  MoreHorizontal: () => null,
  RefreshCw: () => null,
  RotateCcw: () => null,
  Search: () => null,
  Star: () => null,
}));
vi.mock("@/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuRadioGroup: ({ children }: { children?: unknown }) =>
    children ?? null,
  DropdownMenuRadioItem: ({ children }: { children?: unknown }) =>
    children ?? null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) =>
    children ?? null,
}));

const preferences = {
  defaultModels: {},
  modelOverrides: {
    orchestrator: "openai-codex/gpt-5.6-sol",
    general: "openai-codex/gpt-5.6-sol",
  },
  assistantPropagatedAgents: [],
  reasoningEfforts: {},
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "codex_cli" as const,
  codexModel: "gpt-5.6-sol",
  codexModelExplicit: true,
  codexReasoningEffort: "default" as const,
  claudeCodeModel: "default",
  claudeCodeReasoningEffort: "default" as const,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

const emptySnapshot: RuntimeModelCatalogSnapshot = {
  revision: 100,
  models: [],
  runtimeManagedProviders: [],
  refreshedAt: null,
};

const recoveredSnapshot: RuntimeModelCatalogSnapshot = {
  revision: 200,
  models: [
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  ],
  runtimeManagedProviders: [],
  refreshedAt: 200,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const settle = async () => {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("EngineTabContent catalog recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
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
    vi.restoreAllMocks();
  });

  it("refreshes runtime and Codex catalogs together until their intersection recovers", async () => {
    const runtimeRefresh = deferred<RuntimeModelCatalogSnapshot>();
    const codexRefresh = deferred<{
      models: Array<{ id: string; hidden: boolean }>;
    }>();
    const listLlmModels = vi
      .fn()
      .mockResolvedValueOnce(emptySnapshot)
      .mockImplementationOnce(() => runtimeRefresh.promise);
    const liveCodexModels = {
      models: [{ id: "gpt-5.6-sol", hidden: false }],
    };
    const listCodexModels = vi
      .fn()
      .mockResolvedValueOnce(liveCodexModels)
      .mockImplementationOnce(() => codexRefresh.promise);

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: { onAvailability: vi.fn(() => () => {}) },
      system: {
        getLocalModelPreferences: vi.fn(async () => ({ ...preferences })),
        setLocalModelPreferences: vi.fn(
          async (patch: Record<string, unknown>) => ({
            ...preferences,
            ...patch,
          }),
        ),
        listCodexModels,
        listClaudeCodeModels: vi.fn(async () => ({ models: [] })),
        listLlmModels,
        onLlmModelsUpdated: vi.fn(() => () => {}),
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [], defaults: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { EngineTabContent } =
      await import("@/shell/display/EngineTabContent");
    await act(async () => {
      root.render(<EngineTabContent />);
    });
    await settle();

    expect(container.textContent).toContain(
      "No models are currently available to both ChatGPT and Codex.",
    );
    const refresh = container.querySelector(
      ".engine-runtime-model-panel__refresh",
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();

    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });

    expect(listLlmModels).toHaveBeenCalledTimes(2);
    expect(listCodexModels).toHaveBeenCalledTimes(2);
    expect(refresh?.disabled).toBe(true);
    expect(refresh?.textContent).toContain("Refreshing…");

    runtimeRefresh.resolve(recoveredSnapshot);
    await settle();
    expect(refresh?.disabled).toBe(true);
    expect(refresh?.textContent).toContain("Refreshing…");

    codexRefresh.resolve(liveCodexModels);
    await settle();
    expect(refresh?.disabled).toBe(false);
    expect(container.textContent).not.toContain(
      "No models are currently available to both ChatGPT and Codex.",
    );
    expect(container.textContent).toContain("GPT-5.6 Sol");
  });
});
