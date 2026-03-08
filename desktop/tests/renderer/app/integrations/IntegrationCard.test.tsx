import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Integration } from "../../../../src/app/integrations/integration-configs";
import { IntegrationDetailArea, IntegrationGridCard } from "../../../../src/app/integrations/IntegrationCard";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockShowToast = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock("@/ui/toast", () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

const makeIntegration = (overrides: Partial<Integration>): Integration => ({
  provider: "discord",
  displayName: "Discord",
  type: "bot",
  group: "messaging",
  brandColor: "#5865F2",
  icon: <span>D</span>,
  instructions: "Send Stella your code",
  ...overrides,
});

describe("IntegrationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseMutation.mockReturnValue(
      vi.fn(async (args: Record<string, unknown>) => {
        if (args && args.provider === "discord") {
          return { code: "ABC123" };
        }
        if (args && Object.keys(args).length === 0) {
          return { url: "https://slack.example/install" };
        }
        return null;
      }),
    );

    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: vi.fn(),
      },
      configurable: true,
    });
  });

  it("shows connected badge in grid card when connection exists", () => {
    const onClick = vi.fn();
    mockUseQuery.mockReturnValue({ _id: "conn-1" });

    const { container } = render(
      <IntegrationGridCard
        integration={makeIntegration({})}
        isSelected={false}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".connect-grid-card-badge")).toBeTruthy();
  });

  it("renders bot setup, loads link code, and copies it", async () => {
    mockUseQuery.mockReturnValue(null);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
          botLink: "https://discord.example/bot",
        })}
      />,
    );

    expect(screen.getByText("Send Stella your code")).toBeInTheDocument();

    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABC123");
    expect(mockShowToast).toHaveBeenCalledWith("Code copied to clipboard");
    expect(screen.getByRole("link", { name: /Find bot on Discord/i })).toBeInTheDocument();
  });

  it("does not render unsafe bot links", async () => {
    mockUseQuery.mockReturnValue(null);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
          botLink: "javascript:alert(1)",
        })}
      />,
    );

    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Find bot on Discord/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an error and hides Slack link when install URL is unsafe", async () => {
    const generateCodeFn = vi.fn().mockResolvedValue({ code: "SLACK123" });
    const createSlackInstallUrlFn = vi
      .fn()
      .mockResolvedValue({ url: "javascript:alert(1)" });
    let mutationCalls = 0;

    mockUseMutation.mockImplementation(() => {
      mutationCalls += 1;
      return mutationCalls % 2 === 1 ? generateCodeFn : createSlackInstallUrlFn;
    });
    mockUseQuery.mockReturnValue(null);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "slack",
          displayName: "Slack",
          botLink: "https://slack.example/fallback",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Received an invalid install link")).toBeInTheDocument();
    });

    expect(generateCodeFn).toHaveBeenCalledWith({ provider: "slack" });
    expect(createSlackInstallUrlFn).toHaveBeenCalledWith({});
    expect(screen.queryByRole("link", { name: /Find bot on Slack/i })).not.toBeInTheDocument();
    expect(screen.queryByText("SLACK123")).not.toBeInTheDocument();
  });

  it("disconnects a connected integration and shows success toast", async () => {
    const mutationFn = vi.fn().mockResolvedValue(null);

    mockUseQuery.mockReturnValue({ _id: "conn-2" });
    mockUseMutation.mockReturnValue(mutationFn);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(mutationFn).toHaveBeenCalledWith({ provider: "discord" });
    });
    expect(mockShowToast).toHaveBeenCalledWith("Disconnected from Discord");
  });

  it("shows failure toast when disconnect fails", async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error("delete failed"));

    mockUseQuery.mockReturnValue({ _id: "conn-3" });
    mockUseMutation.mockReturnValue(mutationFn);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
          type: "bot",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("Failed to disconnect from Discord");
    });
  });
});

