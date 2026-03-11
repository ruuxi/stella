import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "convex/react";
import { ModelPreferencesBridge } from "@/app/settings/ModelPreferencesBridge";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => undefined),
}));
const mockUseAuthSessionState = vi.fn(() => ({
  hasConnectedAccount: true,
}));
vi.mock("@/app/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    data: {
      preferences: {
        getModelDefaults: "preferences.getModelDefaults",
        getModelOverrides: "preferences.getModelOverrides",
        getGeneralAgentEngine: "preferences.getGeneralAgentEngine",
        getCodexLocalMaxConcurrency: "preferences.getCodexLocalMaxConcurrency",
      },
    },
  },
}));

const mockSyncLocalModelPreferences = vi.fn();

describe("ModelPreferencesBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: true });
    window.electronAPI = {
      system: {
        syncLocalModelPreferences: mockSyncLocalModelPreferences,
      },
    } as unknown as typeof window.electronAPI;

    vi.mocked(useQuery).mockImplementation(((queryPath: unknown) => {
      const path = queryPath as string;
      if (path === "preferences.getModelDefaults") {
        return [
          { agentType: "orchestrator", model: "stella/default", resolvedModel: "moonshotai/kimi-k2.5" },
          { agentType: "general", model: "stella/default", resolvedModel: "moonshotai/kimi-k2.5" },
          { agentType: "browser", model: "stella/default", resolvedModel: "anthropic/claude-sonnet-4.6" },
          { agentType: "explore", model: "stella/default", resolvedModel: "zai/glm-4.7" },
          { agentType: "app", model: "stella/default", resolvedModel: "anthropic/claude-sonnet-4.6" },
        ];
      }
      if (path === "preferences.getModelOverrides") {
        return JSON.stringify({
          orchestrator: "stella/default",
          browser: "openai/gpt-4o",
        });
      }
      if (path === "preferences.getGeneralAgentEngine") {
        return "claude_code_local";
      }
      if (path === "preferences.getCodexLocalMaxConcurrency") {
        return 2;
      }
      return undefined;
    }) as never);
  });

  it("syncs normalized model preferences into local Electron state", async () => {
    render(<ModelPreferencesBridge />);

    await waitFor(() => {
      expect(mockSyncLocalModelPreferences).toHaveBeenCalledWith({
        defaultModels: {
          orchestrator: "stella/default",
          general: "stella/default",
          browser: "stella/default",
          explore: "stella/default",
          app: "stella/default",
        },
        resolvedDefaultModels: {
          orchestrator: "moonshotai/kimi-k2.5",
          general: "moonshotai/kimi-k2.5",
          browser: "anthropic/claude-sonnet-4.6",
          explore: "zai/glm-4.7",
          app: "anthropic/claude-sonnet-4.6",
        },
        modelOverrides: {
          browser: "openai/gpt-4o",
        },
        generalAgentEngine: "claude_code_local",
        codexLocalMaxConcurrency: 2,
      });
    });
  });

  it("does nothing when the Electron sync API is unavailable", () => {
    window.electronAPI = {
      system: {},
    } as unknown as typeof window.electronAPI;

    render(<ModelPreferencesBridge />);

    expect(mockSyncLocalModelPreferences).not.toHaveBeenCalled();
  });

  it("skips Convex preference sync when unauthenticated", () => {
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: false });

    render(<ModelPreferencesBridge />);

    expect(mockSyncLocalModelPreferences).not.toHaveBeenCalled();
  });
});
