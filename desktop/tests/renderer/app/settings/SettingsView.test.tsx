import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { useQuery, useMutation, useAction } from "convex/react";
import { loadStripe } from "@stripe/stripe-js";
import SettingsDialog from "../../../../src/global/settings/SettingsView";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => undefined),
  useMutation: vi.fn(() => vi.fn()),
  useAction: vi.fn(() => vi.fn()),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-embedded-checkout-provider">{children}</div>
  ),
  EmbeddedCheckout: () => <div data-testid="stripe-embedded-checkout" />,
}));

const mockUseAuthSessionState = vi.fn(() => ({
  hasConnectedAccount: true,
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    billing: {
      getSubscriptionStatus: "billing.getSubscriptionStatus",
      createEmbeddedCheckoutSession: "billing.createEmbeddedCheckoutSession",
      createBillingPortalSession: "billing.createBillingPortalSession",
    },
    data: {
      preferences: {
        getModelDefaults: "preferences.getModelDefaults",
        getModelOverrides: "preferences.getModelOverrides",
        setModelOverride: "preferences.setModelOverride",
        clearModelOverride: "preferences.clearModelOverride",
        getGeneralAgentEngine: "preferences.getGeneralAgentEngine",
        setGeneralAgentEngine: "preferences.setGeneralAgentEngine",
        getSelfModAgentEngine: "preferences.getSelfModAgentEngine",
        setSelfModAgentEngine: "preferences.setSelfModAgentEngine",
        getMaxAgentConcurrency: "preferences.getMaxAgentConcurrency",
        setMaxAgentConcurrency: "preferences.setMaxAgentConcurrency",
      },
      secrets: {
        listSecrets: "secrets.listSecrets",
        createSecret: "secrets.createSecret",
        deleteSecret: "secrets.deleteSecret",
      },
    },
  },
}));

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: vi.fn(() => ({
    models: [
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "moonshotai" },
      {
        id: "anthropic/claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
      },
      { id: "anthropic/claude-3", name: "Claude 3", provider: "anthropic" },
      { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
      { id: "zai/glm-4.7", name: "GLM 4.7", provider: "zai" },
    ],
    groups: [
      {
        provider: "moonshotai",
        models: [{ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" }],
      },
      {
        provider: "anthropic",
        models: [
          { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { id: "anthropic/claude-3", name: "Claude 3" },
        ],
      },
      { provider: "openai", models: [{ id: "openai/gpt-4o", name: "GPT-4o" }] },
      { provider: "zai", models: [{ id: "zai/glm-4.7", name: "GLM 4.7" }] },
    ],
    loading: false,
  })),
}));

const mockListLlmCredentials = vi.fn();
const mockSaveLlmCredential = vi.fn();
const mockDeleteLlmCredential = vi.fn();
const mockOpenExternal = vi.fn();
const mockCreateEmbeddedCheckoutSession = vi.fn();
const mockCreateBillingPortalSession = vi.fn();

type BillingStatusFixture = {
  authenticated: boolean;
  isAnonymous: boolean;
  plan: "free" | "go" | "pro" | "plus";
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  usage: {
    rollingUsedUsd: number;
    rollingLimitUsd: number;
    weeklyUsedUsd: number;
    weeklyLimitUsd: number;
    monthlyUsedUsd: number;
    monthlyLimitUsd: number;
  };
  plans: {
    free: {
      label: string;
      monthlyPriceCents: number;
      rollingLimitUsd: number;
      rollingWindowHours: number;
      weeklyLimitUsd: number;
      monthlyLimitUsd: number;
      tokensPerMinute: number;
    };
    go: {
      label: string;
      monthlyPriceCents: number;
      rollingLimitUsd: number;
      rollingWindowHours: number;
      weeklyLimitUsd: number;
      monthlyLimitUsd: number;
      tokensPerMinute: number;
    };
    pro: {
      label: string;
      monthlyPriceCents: number;
      rollingLimitUsd: number;
      rollingWindowHours: number;
      weeklyLimitUsd: number;
      monthlyLimitUsd: number;
      tokensPerMinute: number;
    };
    plus: {
      label: string;
      monthlyPriceCents: number;
      rollingLimitUsd: number;
      rollingWindowHours: number;
      weeklyLimitUsd: number;
      monthlyLimitUsd: number;
      tokensPerMinute: number;
    };
  };
};

const DEFAULT_BILLING_STATUS: BillingStatusFixture = {
  authenticated: true,
  isAnonymous: false,
  plan: "free",
  subscriptionStatus: "none",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  usage: {
    rollingUsedUsd: 0,
    rollingLimitUsd: 3,
    weeklyUsedUsd: 0,
    weeklyLimitUsd: 8,
    monthlyUsedUsd: 0,
    monthlyLimitUsd: 15,
  },
  plans: {
    free: {
      label: "Free",
      monthlyPriceCents: 0,
      rollingLimitUsd: 3,
      rollingWindowHours: 5,
      weeklyLimitUsd: 8,
      monthlyLimitUsd: 15,
      tokensPerMinute: 150_000,
    },
    go: {
      label: "Go",
      monthlyPriceCents: 1_000,
      rollingLimitUsd: 12,
      rollingWindowHours: 5,
      weeklyLimitUsd: 30,
      monthlyLimitUsd: 60,
      tokensPerMinute: 500_000,
    },
    pro: {
      label: "Pro",
      monthlyPriceCents: 10_000,
      rollingLimitUsd: 60,
      rollingWindowHours: 5,
      weeklyLimitUsd: 150,
      monthlyLimitUsd: 300,
      tokensPerMinute: 2_500_000,
    },
    plus: {
      label: "Plus",
      monthlyPriceCents: 20_000,
      rollingLimitUsd: 240,
      rollingWindowHours: 5,
      weeklyLimitUsd: 600,
      monthlyLimitUsd: 1_200,
      tokensPerMinute: 10_000_000,
    },
  },
};

// Lightweight mock of the Radix-based Dialog components so that the dialog
// content is rendered synchronously in jsdom when `open` is true.
vi.mock("@/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="dialog-root">
        <button
          type="button"
          data-testid="dialog-close"
          onClick={() => onOpenChange(false)}
        >
          close
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({
    children,
  }: {
    children: React.ReactNode;
    size?: string;
    className?: string;
  }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogCloseButton: () => <button type="button">X</button>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(
  overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {},
) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
}

function mockUseQuery(impl: (queryPath: unknown, args?: unknown) => unknown) {
  vi.mocked(useQuery).mockImplementation(impl as never);
}

function mockUseMutation(impl: (mutationPath: unknown) => unknown) {
  vi.mocked(useMutation).mockImplementation(impl as never);
}

function mockUseAction(impl: (actionPath: unknown) => unknown) {
  vi.mocked(useAction).mockImplementation(impl as never);
}

function setupUseAction() {
  mockCreateEmbeddedCheckoutSession.mockReset();
  mockCreateBillingPortalSession.mockReset();
  mockCreateEmbeddedCheckoutSession.mockResolvedValue({
    publishableKey: "pk_test_checkout",
    clientSecret: "cs_test_checkout",
    sessionId: "sess_test_checkout",
  });
  mockCreateBillingPortalSession.mockResolvedValue({
    url: "https://billing.stella.app/portal",
  });

  mockUseAction((actionPath: unknown) => {
    const path = actionPath as string;
    if (path === "billing.createEmbeddedCheckoutSession") {
      return mockCreateEmbeddedCheckoutSession;
    }
    if (path === "billing.createBillingPortalSession") {
      return mockCreateBillingPortalSession;
    }
    return vi.fn();
  });
}

/**
 * Configure useQuery mock to return different values based on query key.
 */
function setupUseQuery(
  opts: {
    modelDefaults?: Array<{
      agentType: string;
      model: string;
      resolvedModel: string;
    }>;
    modelOverrides?: string;
    generalAgentEngine?: "default" | "claude_code_local";
    selfModAgentEngine?: "default" | "claude_code_local";
    maxAgentConcurrency?: number;
    billingStatus?: BillingStatusFixture;
  } = {},
) {
  mockUseQuery((queryPath: unknown) => {
    const path = queryPath as string;
    if (path === "preferences.getModelDefaults") {
      return Object.prototype.hasOwnProperty.call(opts, "modelDefaults")
        ? opts.modelDefaults
        : [
            {
              agentType: "orchestrator",
              model: "stella/default",
              resolvedModel: "moonshotai/kimi-k2.5",
            },
            {
              agentType: "general",
              model: "stella/default",
              resolvedModel: "moonshotai/kimi-k2.5",
            },
            {
              agentType: "self_mod",
              model: "stella/default",
              resolvedModel: "moonshotai/kimi-k2.5",
            },
            {
              agentType: "browser",
              model: "stella/default",
              resolvedModel: "anthropic/claude-sonnet-4.6",
            },
            {
              agentType: "explore",
              model: "stella/default",
              resolvedModel: "zai/glm-4.7",
            },
          ];
    }
    if (path === "preferences.getModelOverrides") {
      return Object.prototype.hasOwnProperty.call(opts, "modelOverrides")
        ? opts.modelOverrides
        : JSON.stringify({});
    }
    if (path === "preferences.getGeneralAgentEngine") {
      return Object.prototype.hasOwnProperty.call(opts, "generalAgentEngine")
        ? opts.generalAgentEngine
        : "default";
    }
    if (path === "preferences.getSelfModAgentEngine") {
      return Object.prototype.hasOwnProperty.call(opts, "selfModAgentEngine")
        ? opts.selfModAgentEngine
        : "default";
    }
    if (path === "preferences.getMaxAgentConcurrency") {
      return Object.prototype.hasOwnProperty.call(
        opts,
        "maxAgentConcurrency",
      )
        ? opts.maxAgentConcurrency
        : 24;
    }
    if (path === "billing.getSubscriptionStatus") {
      return opts.billingStatus ?? DEFAULT_BILLING_STATUS;
    }
    return undefined;
  });
}

function setupElectronApi(
  credentials: Array<{
    provider: string;
    label: string;
    status: "active";
    updatedAt?: number;
  }> = [],
) {
  setupUseAction();
  mockOpenExternal.mockReset();

  mockListLlmCredentials.mockResolvedValue(
    credentials.map((entry, index) => ({
      provider: entry.provider,
      label: entry.label,
      status: entry.status,
      updatedAt: entry.updatedAt ?? index + 1,
    })),
  );
  mockSaveLlmCredential.mockImplementation(
    async (payload: {
      provider: string;
      label: string;
      plaintext: string;
    }) => ({
      provider: payload.provider,
      label: payload.label,
      status: "active" as const,
      updatedAt: Date.now(),
    }),
  );
  mockDeleteLlmCredential.mockResolvedValue({ removed: true });

  window.electronAPI = {
    system: {
      listLlmCredentials: mockListLlmCredentials,
      saveLlmCredential: mockSaveLlmCredential,
      deleteLlmCredential: mockDeleteLlmCredential,
      openExternal: mockOpenExternal,
    },
  } as unknown as typeof window.electronAPI;
}

async function openModelsTab() {
  await act(async () => {
    fireEvent.click(screen.getByText("Models"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(mockListLlmCredentials).toHaveBeenCalled();
    expect(screen.getByText("Provider Credentials")).toBeTruthy();
  });
}

async function renderModelsTab() {
  render(<SettingsDialog {...defaultProps()} />);
  await openModelsTab();
}

async function openBillingTab() {
  await act(async () => {
    fireEvent.click(screen.getByText("Billing"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("Plans")).toBeTruthy();
  });
}

async function renderBillingTab() {
  render(<SettingsDialog {...defaultProps()} />);
  await openBillingTab();
}

const LLM_PROVIDER_ROW_COUNT = 13;

// ---------------------------------------------------------------------------
// Tests: Dialog rendering
// ---------------------------------------------------------------------------

describe("SettingsDialog rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: true });
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders nothing visible when open=false", () => {
    const { container } = render(
      <SettingsDialog {...defaultProps({ open: false })} />,
    );
    expect(screen.queryByText("Settings")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("shows settings dialog content when open=true", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("renders the dialog root element when open", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByTestId("dialog-root")).toBeTruthy();
  });

  it("calls onOpenChange(false) when close button is clicked", () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog {...defaultProps({ onOpenChange })} />);

    fireEvent.click(screen.getByTestId("dialog-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab switching
// ---------------------------------------------------------------------------

describe("Tab switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("shows Basic, Models, and Billing tabs in sidebar", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("Models")).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
  });

  it("shows Basic tab as active by default", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const basicTab = screen.getByText("Basic");
    expect(basicTab.className).toContain("settings-sidebar-tab--active");

    const modelsTab = screen.getByText("Models");
    expect(modelsTab.className).not.toContain("settings-sidebar-tab--active");
  });

  it("shows BasicTab content by default (Storage, Sign Out, etc)", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Storage")).toBeTruthy();
    // "Sign Out" appears as both label and button
    const signOutElements = screen.getAllByText("Sign Out");
    expect(signOutElements.length).toBeGreaterThanOrEqual(2);
  });

  it("switches to Models tab when clicked", async () => {
    render(<SettingsDialog {...defaultProps()} />);

    await openModelsTab();

    // Models tab should now be active
    expect(screen.getByText("Models").className).toContain(
      "settings-sidebar-tab--active",
    );
    expect(screen.getByText("Basic").className).not.toContain(
      "settings-sidebar-tab--active",
    );

    // Models tab content should appear
    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(screen.getByText("Provider Credentials")).toBeTruthy();

    // Basic tab content should be hidden
    expect(screen.queryByText("Storage")).toBeNull();
  });

  it("switches back to Basic tab from Models", async () => {
    render(<SettingsDialog {...defaultProps()} />);

    await openModelsTab();
    expect(screen.queryByText("Storage")).toBeNull();

    fireEvent.click(screen.getByText("Basic"));
    expect(screen.getByText("Storage")).toBeTruthy();
    expect(screen.queryByText("Model Configuration")).toBeNull();
  });
});

describe("BillingTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    setupUseQuery();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders billing status and plan cards when Billing is selected", async () => {
    await renderBillingTab();

    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("Plans")).toBeTruthy();
    expect(screen.getByText("Choose Go")).toBeTruthy();
    expect(screen.getByText("Choose Pro")).toBeTruthy();
    expect(screen.getByText("Choose Plus")).toBeTruthy();
  });

  it("starts embedded checkout for a paid plan", async () => {
    await renderBillingTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Choose Go"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockCreateEmbeddedCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "go" }),
      );
      expect(loadStripe).toHaveBeenCalledWith("pk_test_checkout");
      expect(screen.getByText("Checkout")).toBeTruthy();
      expect(screen.getByTestId("stripe-embedded-checkout")).toBeTruthy();
    });

    const checkoutArgs = mockCreateEmbeddedCheckoutSession.mock.calls[0]?.[0] as {
      returnUrl: string;
    };
    expect(checkoutArgs.returnUrl).toContain("billingCheckout=complete");
  });

  it("reconciles redirect-based checkout returns on mount", async () => {
    window.history.replaceState({}, "", "/?billingCheckout=complete");

    render(<SettingsDialog {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText("Current plan")).toBeTruthy();
      expect(
        screen.getByText("Checkout complete. Stella is syncing your billing status now."),
      ).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Billing" }).className).toContain(
      "settings-sidebar-tab--active",
    );
    expect(window.location.search).toBe("");
  });

  it("opens billing portal in the host shell", async () => {
    setupUseQuery({
      billingStatus: {
        ...DEFAULT_BILLING_STATUS,
        plan: "go",
        subscriptionStatus: "active",
      },
    });

    await renderBillingTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Manage Billing"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockCreateBillingPortalSession).toHaveBeenCalled();
      expect(mockOpenExternal).toHaveBeenCalledWith(
        "https://billing.stella.app/portal",
      );
    });
  });
});

describe("Basic tab privacy copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("shows local-only storage wording", () => {
    render(<SettingsDialog {...defaultProps()} />);

    expect(screen.getByText("Storage")).toBeTruthy();
    expect(
      screen.getByText(/Local only\. Conversations stay on this device\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Cloud sync is not available in the app right now\./,
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: BasicTab
// ---------------------------------------------------------------------------

describe("BasicTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Sign Out row with Sign Out button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Sign out of your account")).toBeTruthy();

    const signOutBtn = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "Sign Out");
    expect(signOutBtn).toBeTruthy();
  });

  it("calls onSignOut when Sign Out button is clicked", () => {
    const onSignOut = vi.fn();
    render(<SettingsDialog {...defaultProps({ onSignOut })} />);

    const signOutBtn = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "Sign Out");
    fireEvent.click(signOutBtn!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("renders Delete Data row as disabled until the feature is implemented", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Data")).toBeTruthy();
    expect(
      screen.getByText("Erase all conversations and memories."),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        "This action is not available in the desktop app yet.",
      )[0],
    ).toBeTruthy();

    const deleteButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.textContent === "Delete");
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    expect(deleteButtons[0].className).toContain("settings-btn--danger");
    expect(deleteButtons[0]).toBeDisabled();
  });

  it("renders Delete Account row as disabled until the feature is implemented", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Account")).toBeTruthy();
    expect(
      screen.getByText("Permanently remove your account and all data."),
    ).toBeTruthy();

    const deleteButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.textContent === "Delete");
    // There should be two Delete buttons: Delete Data and Delete Account
    expect(deleteButtons.length).toBe(2);
    expect(deleteButtons[1].className).toContain("settings-btn--danger");
    expect(deleteButtons[1]).toBeDisabled();
  });

  it("renders all five BasicTab rows", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const rows = document.querySelectorAll(".settings-row");
    expect(rows.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: ModelConfigSection
// ---------------------------------------------------------------------------

describe("AgentRuntimeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Agent Runtime section on Models tab", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Agent Runtime")).toBeTruthy();
    expect(screen.getByText("Engine")).toBeTruthy();
    expect(screen.getByText("Self Mod Engine")).toBeTruthy();
    expect(screen.getByText("Max Agent Concurrency")).toBeTruthy();
  });

  it("shows shared local concurrency control even when engines are default", async () => {
    setupUseQuery({ generalAgentEngine: "default" });
    await renderModelsTab();

    expect(screen.getByText("Max Agent Concurrency")).toBeTruthy();
  });

  it("shows saved runtime values for both agents and shared concurrency", async () => {
    setupUseQuery({
      generalAgentEngine: "default",
      selfModAgentEngine: "claude_code_local",
      maxAgentConcurrency: 24,
    });
    await renderModelsTab();

    expect(screen.getByText("Max Agent Concurrency")).toBeTruthy();
    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(3);
    expect(selects[0].value).toBe("default");
    expect(selects[1].value).toBe("claude_code_local");
    expect(selects[2].value).toBe("24");
  });

  it("waits for saved runtime preferences before rendering editable values", async () => {
    setupUseQuery({
      generalAgentEngine: undefined,
      selfModAgentEngine: undefined,
      maxAgentConcurrency: undefined,
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(3);
    expect(selects[0].disabled).toBe(true);
    expect(selects[1].disabled).toBe(true);
    expect(selects[2].disabled).toBe(true);
    expect(selects[0].value).toBe("loading");
    expect(selects[1].value).toBe("loading");
    expect(selects[2].value).toBe("loading");
  });

  it("calls setGeneralAgentEngine when engine is changed back to default", async () => {
    const mockSetGeneralAgentEngine = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery({
      generalAgentEngine: "claude_code_local",
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "default" } });
      await Promise.resolve();
    });

    expect(mockSetGeneralAgentEngine).toHaveBeenCalledWith({
      engine: "default",
    });
  });

  it("shows Claude Code option in agent runtime engine selects", async () => {
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBeGreaterThanOrEqual(1);
    const options = Array.from(selects[0].querySelectorAll("option")).map(
      (opt) => opt.value,
    );
    expect(options).toContain("claude_code_local");
  });

  it("calls setGeneralAgentEngine when engine is changed to claude_code_local", async () => {
    const mockSetGeneralAgentEngine = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "claude_code_local" } });
      await Promise.resolve();
    });

    expect(mockSetGeneralAgentEngine).toHaveBeenCalledWith({
      engine: "claude_code_local",
    });
  });

  it("rolls back runtime changes and shows an error when saving fails", async () => {
    const mockSetGeneralAgentEngine = vi
      .fn()
      .mockRejectedValueOnce(new Error("Runtime save failed"));
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "claude_code_local" } });
      await Promise.resolve();
    });

    await waitFor(() => {
      const nextSelects = document.querySelectorAll(
        ".settings-runtime-select",
      ) as NodeListOf<HTMLSelectElement>;
      expect(nextSelects[0].value).toBe("default");
      expect(screen.getByText("Runtime save failed")).toBeTruthy();
    });
  });

  it("calls setSelfModAgentEngine when self-mod engine changes", async () => {
    const mockSetSelfModAgentEngine = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setSelfModAgentEngine")
        return mockSetSelfModAgentEngine;
      return vi.fn();
    });
    setupUseQuery({
      selfModAgentEngine: "default",
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: "claude_code_local" } });
      await Promise.resolve();
    });

    expect(mockSetSelfModAgentEngine).toHaveBeenCalledWith({
      engine: "claude_code_local",
    });
  });

  it("calls setMaxAgentConcurrency when max agent concurrency changes", async () => {
    const mockSetMaxAgentConcurrency = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setMaxAgentConcurrency")
        return mockSetMaxAgentConcurrency;
      return vi.fn();
    });
    setupUseQuery({
      maxAgentConcurrency: 24,
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[2], { target: { value: "12" } });
      await Promise.resolve();
    });

    expect(mockSetMaxAgentConcurrency).toHaveBeenCalledWith({ value: 12 });
  });
});

describe("ModelConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Model Configuration title and description", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(
      screen.getByText("Override the default model for each agent type."),
    ).toBeTruthy();
  });

  it("renders all configurable agents with labels and descriptions", async () => {
    setupUseQuery();
    await renderModelsTab();

    // Agent labels
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Self Mod")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();

    // Agent descriptions
    expect(
      screen.getByText("Top-level agent that delegates tasks"),
    ).toBeTruthy();
    expect(screen.getByText("Full tool access for general tasks")).toBeTruthy();
    expect(
      screen.getByText("Stella internal code, prompts, runtime, and UI"),
    ).toBeTruthy();
    expect(screen.getByText("Browser automation via Playwright")).toBeTruthy();
    expect(screen.getByText("Lightweight read-only exploration")).toBeTruthy();
  });

  it("shows default model labels in select dropdowns", async () => {
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(5);

    // Check that defaults appear as the first option in each select
    const defaultTexts = Array.from(selects).map((sel) => {
      const firstOption = sel.querySelector("option");
      return firstOption?.textContent;
    });

    expect(defaultTexts).toContain("Stella Recommended (currently Kimi K2.5)");
    expect(defaultTexts).toContain(
      "Stella Recommended (currently Claude Sonnet 4.6)",
    );
    expect(defaultTexts).toContain("Stella Recommended (currently GLM 4.7)");
  });

  it("shows model options from the catalog in optgroups", async () => {
    setupUseQuery();
    await renderModelsTab();

    const optgroups = document.querySelectorAll("optgroup");
    expect(optgroups.length).toBeGreaterThanOrEqual(2);

    const labels = Array.from(optgroups).map((og) => og.getAttribute("label"));
    expect(labels).toContain("anthropic");
    expect(labels).toContain("openai");
  });

  it("selects have current value from overrides", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    // First select is orchestrator
    expect(selects[0].value).toBe("openai/gpt-4o");
    // Second select (general) should be empty (default)
    expect(selects[1].value).toBe("");
  });

  it("treats explicit default overrides as the default option", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "stella/default" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects[0].value).toBe("");
    expect(
      document.querySelectorAll(".settings-model-reset-icon"),
    ).toHaveLength(0);
  });

  it("shows reset icon when agent has an override", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    // Reset icons should exist for agents with overrides
    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(1);
  });

  it("does not show reset icon when agent has no override", async () => {
    setupUseQuery({ modelOverrides: JSON.stringify({}) });
    await renderModelsTab();

    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(0);
  });

  it("shows Reset All button when there are overrides", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const resetAllBtn = screen.getByText("Reset All");
    expect(resetAllBtn).toBeTruthy();
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("visible");
  });

  it("hides Reset All button when there are no overrides", async () => {
    setupUseQuery({ modelOverrides: JSON.stringify({}) });
    await renderModelsTab();

    const resetAllBtn = screen.getByText("Reset All");
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("hidden");
  });

  it("calls setModelOverride mutation when a model is selected", async () => {
    const mockSetOverride = vi.fn();
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "openai/gpt-4o" } });
      await Promise.resolve();
    });

    expect(mockSetOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
      model: "openai/gpt-4o",
    });
  });

  it("rolls back model override changes and shows an error when saving fails", async () => {
    const mockSetOverride = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model save failed"));
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      return vi.fn();
    });

    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "openai/gpt-4o" } });
      await Promise.resolve();
    });

    await waitFor(() => {
      const nextSelects = document.querySelectorAll(
        ".settings-model-select",
      ) as NodeListOf<HTMLSelectElement>;
      expect(nextSelects[0].value).toBe("");
      expect(screen.getByText("Model save failed")).toBeTruthy();
    });
    expect(
      document.querySelectorAll(".settings-model-reset-icon"),
    ).toHaveLength(0);
  });

  it("calls clearModelOverride mutation when empty value is selected", async () => {
    const mockSetOverride = vi.fn();
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "" } });
      await Promise.resolve();
    });

    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
  });

  it("calls clearModelOverride when reset icon is clicked", async () => {
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const resetIcon = document.querySelector(
      ".settings-model-reset-icon",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(resetIcon);
      await Promise.resolve();
    });

    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
  });

  it("Reset All clears all overrides", async () => {
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({
        orchestrator: "openai/gpt-4o",
        general: "anthropic/claude-3",
      }),
    });
    await renderModelsTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Reset All"));
      await Promise.resolve();
    });

    // Should be called for each overridden agent
    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
    expect(mockClearOverride).toHaveBeenCalledWith({ agentType: "general" });
    expect(mockClearOverride).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: ApiKeysSection
// ---------------------------------------------------------------------------

describe("ApiKeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders provider credentials title and description", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Provider Credentials")).toBeTruthy();
    expect(screen.getByText(/Credentials stay on this device/)).toBeTruthy();
    expect(
      screen.getByText(/Otherwise it uses your Stella provider access\./),
    ).toBeTruthy();
  });

  it("renders all LLM provider rows", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("OpenAI Codex")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText("Kimi (Moonshot AI)")).toBeTruthy();
    expect(screen.getByText("Z.AI")).toBeTruthy();
    expect(screen.getByText("xAI")).toBeTruthy();
    expect(screen.getByText("Groq")).toBeTruthy();
    expect(screen.getByText("Mistral")).toBeTruthy();
    expect(screen.getByText("Cerebras")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("Vercel AI Gateway")).toBeTruthy();
    expect(screen.getByText("OpenCode Zen")).toBeTruthy();
  });

  it("shows 'No key' status when no local credentials exist", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT);
  });

  it("shows 'Key set' status when a local credential exists for a provider", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    expect(screen.getByText("Key set")).toBeTruthy();
    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT - 1);
  });

  it("shows 'Add Credential' button when provider has no local credential", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    expect(addKeyButtons.length).toBe(LLM_PROVIDER_ROW_COUNT);
  });

  it("shows 'Update Credential' and 'Remove' buttons when provider has a local credential", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    expect(screen.getByText("Update Credential")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("shows input field with Save/Cancel when Add Credential is clicked", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    expect(input).toBeTruthy();
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("hides input field when Cancel is clicked", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("calls saveLlmCredential when Save is clicked with input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-test-key-123" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-test-key-123",
    });
  });

  it("does not call saveLlmCredential when Save is clicked with empty input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).not.toHaveBeenCalled();
  });

  it("calls saveLlmCredential when updating an existing key", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    fireEvent.click(screen.getByText("Update Credential"));

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-new-key" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-new-key",
    });
  });

  it("calls deleteLlmCredential when Remove button is clicked", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Remove"));
    });

    expect(mockDeleteLlmCredential).toHaveBeenCalledWith("anthropic");
  });

  it("calls saveLlmCredential on Enter keypress in input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-enter-key" } });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-enter-key",
    });
  });

  it("closes input on Escape keypress", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
  });

  it("only shows Remove button for providers that have an active local credential", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "openai", label: "OpenAI", status: "active" },
    ]);
    await renderModelsTab();

    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBe(1);
  });

  it("does not show 'Key set' when no local credentials exist", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT);
    expect(screen.queryByText("Key set")).toBeNull();
  });

  it("shows correct placeholders for each provider", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");

    fireEvent.click(addKeyButtons[0]);
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(addKeyButtons[1]);
    expect(screen.getByPlaceholderText("sk-...")).toBeTruthy();
  });

  it("input is of type password", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Credential");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...") as HTMLInputElement;
    expect(input.type).toBe("password");
  });
});

// ---------------------------------------------------------------------------
// Tests: SettingsPanel scroll behavior
// ---------------------------------------------------------------------------

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders the settings-panel-wrap container", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const wrap = document.querySelector(".settings-panel-wrap");
    expect(wrap).toBeTruthy();
  });

  it("renders the settings-panel scroll container", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const panel = document.querySelector(".settings-panel");
    expect(panel).toBeTruthy();
  });
});
