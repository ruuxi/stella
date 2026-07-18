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

vi.mock("@/global/settings/ProviderModelPanel", () => ({
  ProviderModelPanel: () => null,
}));
vi.mock("@/global/settings/ProviderOnlyPicker", () => ({
  ProviderOnlyPicker: () => null,
}));
vi.mock("@/global/settings/VoiceCatalogPicker", () => ({
  VoiceCatalogPicker: () => null,
}));
vi.mock("@/global/billing/audience", () => ({
  resolveBillingAudience: () => null,
  getPlanLabel: () => "",
  isRestrictedModelOverrideAudience: () => false,
}));
vi.mock("@/router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/features/workspace-display/default-tabs", () => ({
  openEngineDisplayTab: vi.fn(),
}));
vi.mock("@/shared/hooks/use-edge-fade", () => ({
  useEdgeFadeRef: () => ({ current: null }),
}));
vi.mock("@/ui/brand-icon", () => ({ BrandIcon: () => null }));
vi.mock("@/ui/icons", () => ({
  Check: () => null,
  ChevronDown: () => null,
  MoreHorizontal: () => null,
  RefreshCw: () => null,
  RotateCcw: () => null,
}));
vi.mock("@/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
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

const runtimeModel = (provider: string, id: string, name: string) => ({
  id,
  name,
  provider,
  api: "openai-responses",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
});

const recoveredSnapshot: RuntimeModelCatalogSnapshot = {
  revision: 101,
  models: [
    runtimeModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol"),
    runtimeModel("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
    runtimeModel("google", "gemini-3-flash-preview", "Gemini 3 Flash"),
    runtimeModel("xai", "grok-4.5", "Grok 4.5"),
  ],
  runtimeManagedProviders: [],
  refreshedAt: 101,
};

const restartedSnapshot: RuntimeModelCatalogSnapshot = {
  revision: 202,
  models: [
    ...recoveredSnapshot.models,
    runtimeModel("openai-codex", "gpt-5.5", "GPT-5.5"),
    runtimeModel("groq", "qwen3-32b", "Qwen3 32B"),
  ],
  runtimeManagedProviders: [],
  refreshedAt: 202,
};

const equalRevisionEmptySnapshot: RuntimeModelCatalogSnapshot = {
  revision: recoveredSnapshot.revision,
  models: [],
  runtimeManagedProviders: [],
  refreshedAt: recoveredSnapshot.refreshedAt,
};

const lowerRevisionSnapshot: RuntimeModelCatalogSnapshot = {
  revision: recoveredSnapshot.revision - 1,
  models: [runtimeModel("openai-codex", "gpt-lower-stale", "GPT Lower Stale")],
  runtimeManagedProviders: [],
  refreshedAt: 100,
};

const settle = async () => {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("AgentModelPicker catalog recovery", () => {
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

  it("recovers the real ChatGPT/provider picker path after runner rejection, ready availability, and refresh", async () => {
    let availabilityListener:
      | ((snapshot: { connected: boolean; ready: boolean }) => void)
      | undefined;
    const listLlmModels = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Stella runtime model catalog is not ready."),
      )
      .mockResolvedValueOnce(recoveredSnapshot)
      .mockResolvedValueOnce(restartedSnapshot);
    const listCodexModels = vi.fn(async () => ({
      models: [
        { id: "gpt-5.6-sol", hidden: false },
        { id: "gpt-5.5", hidden: false },
      ],
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: {
        onAvailability: vi.fn(
          (listener: NonNullable<typeof availabilityListener>) => {
            availabilityListener = listener;
            return () => {};
          },
        ),
      },
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

    const { AgentModelPicker } =
      await import("@/global/settings/AgentModelPicker");
    await act(async () => {
      root.render(<AgentModelPicker />);
    });
    await settle();

    expect(container.textContent).toContain(
      "Stella runtime model catalog is not ready.",
    );
    expect(listLlmModels).toHaveBeenCalledTimes(1);

    expect(availabilityListener).toBeTypeOf("function");
    act(() => availabilityListener?.({ connected: false, ready: false }));
    act(() => availabilityListener?.({ connected: true, ready: true }));
    await settle();

    expect(listLlmModels).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(
      "Stella runtime model catalog is not ready.",
    );
    expect(container.textContent).toContain("GPT-5.6 Sol");
    for (const provider of ["Anthropic", "Google", "xAI"]) {
      expect(
        container.querySelector(`button[aria-label="${provider}"]`),
      ).not.toBeNull();
    }

    const refresh = container.querySelector(
      'button[aria-label="Refresh model catalog"]',
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());
    await settle();

    expect(listLlmModels).toHaveBeenCalledTimes(3);
    expect(listCodexModels.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain(
      "No models are currently available to both ChatGPT and Codex.",
    );
    expect(container.textContent).toContain("GPT-5.5");
    expect(container.querySelector('button[aria-label="Groq"]')).not.toBeNull();
  });

  it("clears a reattachment error at the same revision while retaining models and ignoring a lower revision", async () => {
    let availabilityListener:
      | ((snapshot: { connected: boolean; ready: boolean }) => void)
      | undefined;
    const notReady = () =>
      new Error("Stella runtime model catalog is not ready.");
    const listLlmModels = vi
      .fn()
      .mockResolvedValueOnce(recoveredSnapshot)
      .mockRejectedValueOnce(notReady())
      .mockResolvedValueOnce(equalRevisionEmptySnapshot)
      .mockRejectedValueOnce(notReady())
      .mockResolvedValueOnce(lowerRevisionSnapshot);
    const listCodexModels = vi.fn(async () => ({
      models: [
        { id: "gpt-5.6-sol", hidden: false },
        { id: "gpt-lower-stale", hidden: false },
      ],
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: {
        onAvailability: vi.fn(
          (listener: NonNullable<typeof availabilityListener>) => {
            availabilityListener = listener;
            return () => {};
          },
        ),
      },
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

    const { AgentModelPicker } =
      await import("@/global/settings/AgentModelPicker");
    await act(async () => {
      root.render(<AgentModelPicker />);
    });
    await settle();
    expect(container.textContent).toContain("GPT-5.6 Sol");

    let refresh = container.querySelector(
      'button[aria-label="Refresh model catalog"]',
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();
    act(() => availabilityListener?.({ connected: false, ready: false }));
    await act(async () => refresh?.click());
    await settle();
    expect(container.textContent).toContain(notReady().message);
    expect(container.textContent).toContain("GPT-5.6 Sol");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<AgentModelPicker />);
    });
    await settle();
    expect(listLlmModels).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(notReady().message);
    expect(container.textContent).toContain("GPT-5.6 Sol");

    act(() => availabilityListener?.({ connected: true, ready: true }));
    await settle();
    expect(listLlmModels).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain(notReady().message);
    expect(container.textContent).toContain("GPT-5.6 Sol");

    refresh = container.querySelector(
      'button[aria-label="Refresh model catalog"]',
    ) as HTMLButtonElement | null;
    act(() => availabilityListener?.({ connected: false, ready: false }));
    await act(async () => refresh?.click());
    await settle();
    expect(container.textContent).toContain(notReady().message);

    act(() => availabilityListener?.({ connected: true, ready: true }));
    await settle();
    expect(listLlmModels).toHaveBeenCalledTimes(5);
    expect(container.textContent).toContain(notReady().message);
    expect(container.textContent).toContain("GPT-5.6 Sol");
    expect(container.textContent).not.toContain("GPT Lower Stale");
  });
});
