// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setLocalModelPreferences } = vi.hoisted(() => ({
  setLocalModelPreferences: vi.fn(),
}));

vi.mock("@/shell/topbar/nav-surface-preloads", () => ({
  preloadModelsPicker: vi.fn(),
}));

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: () => ({
    models: [],
    allModels: [
      {
        id: "stella/default",
        name: "Stella Default",
        provider: "stella",
      },
      {
        id: "google/gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        provider: "google",
      },
      {
        id: "local/qwen3",
        name: "Qwen 3 Local",
        provider: "local",
      },
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        provider: "openrouter",
      },
    ],
    defaults: [],
    groups: [
      {
        provider: "stella",
        providerName: "Stella",
        models: [
          {
            id: "stella/default",
            name: "Stella Default",
            provider: "stella",
          },
        ],
        runtimeManaged: true,
        runtimeManagedAuth: false,
        runtimeCredentialless: true,
      },
      {
        provider: "google",
        providerName: "Google",
        models: [
          {
            id: "google/gemini-3-flash-preview",
            name: "Gemini 3 Flash",
            provider: "google",
          },
        ],
        runtimeManaged: false,
        runtimeManagedAuth: false,
        runtimeCredentialless: false,
      },
      {
        provider: "local",
        providerName: "Local",
        models: [
          {
            id: "local/qwen3",
            name: "Qwen 3 Local",
            provider: "local",
          },
        ],
        runtimeManaged: false,
        runtimeManagedAuth: false,
        runtimeCredentialless: true,
      },
      {
        provider: "openrouter",
        providerName: "OpenRouter",
        models: [
          {
            id: "openrouter/auto",
            name: "OpenRouter Auto",
            provider: "openrouter",
          },
        ],
        runtimeManaged: false,
        runtimeManagedAuth: false,
        runtimeCredentialless: false,
      },
    ],
    refresh: vi.fn(async () => {}),
    refreshing: false,
    audience: null,
    error: null,
  }),
}));

vi.mock("@/global/settings/hooks/use-codex-model-catalog", () => ({
  useCodexModelCatalog: () => ({
    models: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/global/settings/hooks/use-claude-code-model-catalog", () => ({
  useClaudeCodeModelCatalog: () => ({
    models: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/global/settings/hooks/use-llm-credentials", () => ({
  findApiKey: () => undefined,
  findOauthCredential: () => undefined,
  findOauthProvider: () => undefined,
  useLlmCredentials: () => ({
    apiKeys: [],
    oauthCredentials: [],
    oauthProviders: [],
    validateOAuth: vi.fn(async () => ({
      connected: true,
      needsReauth: false,
    })),
    loginOAuth: vi.fn(async () => {}),
    cancelOAuth: vi.fn(async () => {}),
    saveApiKey: vi.fn(async () => {}),
    removeApiKey: vi.fn(async () => {}),
    logoutOAuth: vi.fn(async () => {}),
    loading: false,
  }),
}));

vi.mock("@/global/settings/ProviderOnlyPicker", () => ({
  ProviderOnlyPicker: () => null,
}));
vi.mock("@/global/settings/VoiceCatalogPicker", () => ({
  VoiceCatalogPicker: () => null,
}));
vi.mock("@/global/billing/audience", () => ({
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
vi.mock("@/ui/toast", () => ({ showToast: vi.fn() }));

const legacyPreferences = {
  defaultModels: {},
  modelOverrides: {},
  assistantPropagatedAgents: [],
  reasoningEfforts: {},
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "default" as const,
  codexModel: "gpt-5.6-sol",
  codexModelExplicit: false,
  codexReasoningEffort: "default" as const,
  codexServiceTier: "standard" as const,
  claudeCodeModel: "default",
  claudeCodeReasoningEffort: "default" as const,
  useNativeCodexRuntime: false,
  useNativeClaudeCodeRuntime: false,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

const waitForMountedPicker = async (): Promise<HTMLElement> => {
  let picker: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      picker = document.body.querySelector('[data-models-picker="true"]');
      expect(picker?.querySelector(".agent-model-picker")).not.toBeNull();
    },
    { timeout: 5_000 },
  );
  return picker as HTMLElement;
};

const clickBrand = async (picker: HTMLElement, label: string) => {
  const button = picker.querySelector(
    `button[role="tab"][aria-label="${label}"]`,
  ) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  await act(async () => button?.click());
};

const clickConnection = async (picker: HTMLElement, label: string) => {
  const button = Array.from(
    picker.querySelectorAll<HTMLButtonElement>(
      '.agent-model-picker-source button[role="tab"]',
    ),
  ).find((candidate) => candidate.textContent?.trim() === label);
  expect(button).not.toBeUndefined();
  await act(async () => button?.click());
};

const waitForDirectControl = async (
  picker: HTMLElement,
  label: string,
): Promise<HTMLInputElement> => {
  let checkbox: HTMLInputElement | null = null;
  await vi.waitFor(() => {
    const option = Array.from(
      picker.querySelectorAll<HTMLLabelElement>(
        ".agent-model-picker-native-runtime-option",
      ),
    ).find((candidate) => candidate.textContent?.includes(label));
    checkbox = option?.querySelector('input[type="checkbox"]') ?? null;
    expect(checkbox).not.toBeNull();
  });
  return checkbox as HTMLInputElement;
};

const waitForNoDirectControl = async (picker: HTMLElement) => {
  await vi.waitFor(() => {
    expect(
      picker.querySelector(".agent-model-picker-native-runtime-option"),
    ).toBeNull();
  });
};

describe("ModelsPicker native agent runtime control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    let persistedPreferences = { ...legacyPreferences };
    setLocalModelPreferences.mockImplementation(
      async (patch: Record<string, unknown>) => {
        persistedPreferences = { ...persistedPreferences, ...patch };
        return persistedPreferences;
      },
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      system: {
        getLocalModelPreferences: vi.fn(async () => persistedPreferences),
        setLocalModelPreferences,
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[data-component="popover-content"]')
      .forEach((element) => element.remove());
    vi.clearAllMocks();
  });

  it("mounts the picker when the Home overlay opens it programmatically", async () => {
    const { ModelsPicker } = await import("@/global/settings/ModelsPicker");
    const trigger = <button type="button">Models</button>;
    await act(async () => {
      root.render(
        <ModelsPicker trigger={trigger} open={false} onOpenChange={() => {}} />,
      );
    });
    expect(
      document.body.querySelector(
        '[data-models-picker="true"] .agent-model-picker',
      ),
    ).toBeNull();

    await act(async () => {
      root.render(
        <ModelsPicker trigger={trigger} open onOpenChange={() => {}} />,
      );
    });

    const picker = await waitForMountedPicker();
    expect(picker.getAttribute("data-state")).toBe("open");
    expect(
      picker.querySelector(".agent-model-picker-native-runtime-option"),
    ).toBeNull();
    expect(picker.textContent?.toLowerCase()).not.toContain("subscription");
  });

  it("shows and persists independent direct runtime controls only on the matching app catalogs", async () => {
    const { ModelsPicker } = await import("@/global/settings/ModelsPicker");
    await act(async () => {
      root.render(
        <ModelsPicker trigger={<button type="button">Models</button>} />,
      );
    });

    const trigger = container.querySelector(
      '[data-slot="models-picker-trigger"]',
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    const picker = await waitForMountedPicker();
    expect(picker.querySelector('[aria-label="Search models"]')).toBeNull();
    await waitForNoDirectControl(picker);
    expect(picker.textContent?.toLowerCase()).not.toContain("subscription");

    await clickBrand(picker, "OpenAI");
    const codexCheckbox = await waitForDirectControl(
      picker,
      "Use Codex instead",
    );
    expect(codexCheckbox.checked).toBe(false);
    expect(codexCheckbox.disabled).toBe(false);
    expect(picker.textContent).toContain(
      "Uses Codex app-server with your native Codex configuration and tools instead of Stella's harness.",
    );
    expect(picker.textContent).not.toContain("Use Claude Code instead");

    await act(async () => codexCheckbox.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenCalledWith({
        useNativeCodexRuntime: true,
      });
      expect(codexCheckbox.checked).toBe(true);
      expect(codexCheckbox.disabled).toBe(false);
    });

    await clickConnection(picker, "API key");
    await waitForNoDirectControl(picker);

    await clickBrand(picker, "Anthropic");
    const claudeCheckbox = await waitForDirectControl(
      picker,
      "Use Claude Code instead",
    );
    expect(claudeCheckbox.checked).toBe(false);
    expect(claudeCheckbox.disabled).toBe(false);
    expect(picker.textContent).toContain(
      "Uses your installed Claude Code configuration, skills, and MCP servers instead of Stella's harness.",
    );
    expect(picker.textContent).not.toContain("Use Codex instead");

    await act(async () => claudeCheckbox.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenLastCalledWith({
        useNativeClaudeCodeRuntime: true,
      });
      expect(claudeCheckbox.checked).toBe(true);
      expect(claudeCheckbox.disabled).toBe(false);
    });

    await clickConnection(picker, "API key");
    await waitForNoDirectControl(picker);

    for (const provider of ["Local", "Google", "OpenRouter"]) {
      await clickBrand(picker, provider);
      await waitForNoDirectControl(picker);
      expect(
        picker.querySelector('[aria-label="Search models"]'),
      ).not.toBeNull();
    }

    await clickBrand(picker, "Stella");
    await waitForNoDirectControl(picker);
    expect(picker.querySelector('[aria-label="Search models"]')).toBeNull();

    await clickBrand(picker, "OpenAI");
    await waitForNoDirectControl(picker);
    await clickConnection(picker, "ChatGPT");
    const persistedCodexCheckbox = await waitForDirectControl(
      picker,
      "Use Codex instead",
    );
    expect(persistedCodexCheckbox.checked).toBe(true);
    await act(async () => persistedCodexCheckbox.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenLastCalledWith({
        useNativeCodexRuntime: false,
      });
      expect(persistedCodexCheckbox.checked).toBe(false);
      expect(persistedCodexCheckbox.disabled).toBe(false);
    });

    await clickBrand(picker, "Anthropic");
    await waitForNoDirectControl(picker);
    await clickConnection(picker, "Claude Code");
    const persistedClaudeCheckbox = await waitForDirectControl(
      picker,
      "Use Claude Code instead",
    );
    expect(persistedClaudeCheckbox.checked).toBe(true);
    await act(async () => persistedClaudeCheckbox.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenLastCalledWith({
        useNativeClaudeCodeRuntime: false,
      });
      expect(persistedClaudeCheckbox.checked).toBe(false);
      expect(persistedClaudeCheckbox.disabled).toBe(false);
    });

    expect(picker.textContent?.toLowerCase()).not.toContain("subscription");
  });
});
