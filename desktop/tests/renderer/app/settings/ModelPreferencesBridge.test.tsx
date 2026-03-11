import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "convex/react";
import { ModelPreferencesBridge } from "@/app/settings/ModelPreferencesBridge";

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true })),
  useQuery: vi.fn(() => undefined),
}));

import { useConvexAuth } from "convex/react";

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
    window.electronAPI = {
      system: {
        syncLocalModelPreferences: mockSyncLocalModelPreferences,
      },
    } as unknown as typeof window.electronAPI;

    vi.mocked(useQuery).mockImplementation(((queryPath: unknown) => {
      const path = queryPath as string;
      if (path === "preferences.getModelDefaults") {
        return [
          { agentType: "orchestrator", model: "moonshotai/kimi-k2.5" },
          { agentType: "general", model: "moonshotai/kimi-k2.5" },
          { agentType: "browser", model: "anthropic/claude-sonnet-4.6" },
          { agentType: "explore", model: "zai/glm-4.7" },
          { agentType: "app", model: "anthropic/claude-sonnet-4.6" },
        ];
      }
      if (path === "preferences.getModelOverrides") {
        return JSON.stringify({
          orchestrator: "moonshotai/kimi-k2.5",
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
    vi.mocked(useConvexAuth).mockReturnValue({ isAuthenticated: false } as never);

    render(<ModelPreferencesBridge />);

    expect(mockSyncLocalModelPreferences).not.toHaveBeenCalled();
  });
});
