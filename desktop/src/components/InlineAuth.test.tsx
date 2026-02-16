import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { InlineAuth } from "./InlineAuth";

const mockFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    $fetch: (...args: unknown[]) => mockFetch(...args),
  },
}));

describe("InlineAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({});
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders email input and submit button", () => {
    render(<InlineAuth />);
    expect(screen.getByText("Enter email to get started")).toBeTruthy();
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(screen.getByText("Send")).toBeTruthy();
  });

  it("applies custom className", () => {
    const { container } = render(<InlineAuth className="my-custom-class" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("my-custom-class");
  });

  it("does nothing when submitting empty email", async () => {
    render(<InlineAuth />);
    fireEvent.click(screen.getByText("Send"));
    // Should not send request for empty email
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing when submitting whitespace-only email", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends magic link request on valid email", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: expect.any(String) },
      });
    });
  });

  it("trims email before sending", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "  user@example.com  " },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: expect.any(String) },
      });
    });
  });

  it("shows success message after sending", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(
        screen.getByText("Check your inbox or spam for your sign-in link"),
      ).toBeTruthy();
    });
    expect(screen.getByText("Go Back")).toBeTruthy();
    // Form should be gone
    expect(screen.queryByPlaceholderText("you@example.com")).toBeNull();
  });

  it("shows 'Sending...' while request is in flight", async () => {
    let resolveRequest: () => void;
    mockFetch.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeTruthy();
    });

    // Submit button should be disabled
    expect(screen.getByText("Sending...")).toBeDisabled();

    resolveRequest!();
    await waitFor(() => {
      expect(
        screen.getByText("Check your inbox or spam for your sign-in link"),
      ).toBeTruthy();
    });
  });

  it("shows error message when request fails", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Something went wrong, try again")).toBeTruthy();
    });
  });

  it("resets to idle state when 'Go Back' is clicked", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(screen.getByText("Go Back")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Go Back"));

    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(screen.getByText("Send")).toBeTruthy();
    expect((screen.getByPlaceholderText("you@example.com") as HTMLInputElement).value).toBe("");
  });

  it("uses Electron protocol callback URL when electronAPI exists", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};

    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: "Stella://auth" },
      });
    });
  });

  it("uses web origin callback URL when electronAPI is absent", async () => {
    render(<InlineAuth />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: expect.any(String) },
      });
      // Ensure it is NOT the Electron protocol URL
      const callbackURL = mockFetch.mock.calls[0][1].body.callbackURL as string;
      expect(callbackURL).not.toContain("://auth");
    });
  });
});
