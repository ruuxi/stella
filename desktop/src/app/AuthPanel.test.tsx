import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthPanel } from "./AuthPanel";

const mockFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    $fetch: (...args: unknown[]) => mockFetch(...args),
  },
}));

vi.mock("@/components/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/text-field", () => ({
  TextField: ({
    label,
    value,
    onChange,
    ...props
  }: {
    label?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    type?: string;
    placeholder?: string;
    autoComplete?: string;
  }) => (
    <label>
      {label}
      <input value={value} onChange={onChange} aria-label={label} {...props} />
    </label>
  ),
}));

describe("AuthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({});
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders header and form", () => {
    render(<AuthPanel />);
    expect(screen.getByText("Welcome to Stella")).toBeTruthy();
    expect(screen.getByText("Sign in to continue.")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByText("Send sign-in email")).toBeTruthy();
  });

  it("shows error when submitting empty email", async () => {
    render(<AuthPanel />);
    fireEvent.click(screen.getByText("Send sign-in email"));
    await waitFor(() => {
      expect(screen.getByText("Enter an email address.")).toBeTruthy();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("trims whitespace-only email and shows error", async () => {
    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));
    await waitFor(() => {
      expect(screen.getByText("Enter an email address.")).toBeTruthy();
    });
  });

  it("sends magic link request on valid email", async () => {
    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Check your inbox for the sign-in link.")).toBeTruthy();
    });
    expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
      method: "POST",
      body: { email: "user@example.com", callbackURL: expect.any(String) },
    });
  });

  it("shows 'Sending...' while request is in flight", async () => {
    let resolveRequest: () => void;
    mockFetch.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeTruthy();
    });

    resolveRequest!();
    await waitFor(() => {
      expect(screen.getByText("Check your inbox for the sign-in link.")).toBeTruthy();
    });
  });

  it("displays error message when magic link request fails", async () => {
    mockFetch.mockRejectedValue(new Error("Server error"));

    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeTruthy();
    });
  });

  it("displays fallback error when error has no message", async () => {
    mockFetch.mockRejectedValue({});

    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Failed to send magic link.")).toBeTruthy();
    });
  });

  it("uses Electron protocol callback URL when electronAPI exists", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};

    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: "Stella://auth" },
      });
    });
  });

  it("uses web origin callback URL when electronAPI is absent", async () => {
    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

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

  it("trims email before sending", async () => {
    render(<AuthPanel />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  user@example.com  " },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "user@example.com", callbackURL: expect.any(String) },
      });
    });
  });
});
