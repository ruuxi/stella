import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CredentialRequestLayer } from "./CredentialRequestLayer";
import type { PendingCredentialRequest } from "./CredentialRequestLayer";

const mockCreateSecret = vi.fn();
vi.mock("convex/react", () => ({
  useMutation: () => mockCreateSecret,
}));

vi.mock("../convex/api", () => ({
  api: {
    data: {
      secrets: {
        createSecret: "createSecret",
      },
    },
  },
}));

let mockElectronApi: Record<string, unknown> | undefined;
vi.mock("../services/electron", () => ({
  getElectronApi: () => mockElectronApi,
}));

let capturedOnSubmit: ((payload: { label: string; secret: string }) => Promise<void>) | undefined;
let capturedOnCancel: (() => void) | undefined;

vi.mock("../components/CredentialModal", () => ({
  CredentialModal: ({
    open,
    provider,
    label,
    description,
    placeholder,
    onSubmit,
    onCancel,
  }: {
    open: boolean;
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
    onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
    onCancel: () => void;
  }) => {
    capturedOnSubmit = onSubmit;
    capturedOnCancel = onCancel;
    return (
      <div data-testid="credential-modal" data-open={open ? "true" : "false"}>
        <span data-testid="provider">{provider}</span>
        {label && <span data-testid="label">{label}</span>}
        {description && <span data-testid="description">{description}</span>}
        {placeholder && <span data-testid="placeholder">{placeholder}</span>}
      </div>
    );
  },
}));

describe("CredentialRequestLayer", () => {
  let credentialCallback: ((_event: unknown, data: PendingCredentialRequest) => void) | null;
  const mockSubmitCredential = vi.fn();
  const mockCancelCredential = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    credentialCallback = null;
    capturedOnSubmit = undefined;
    capturedOnCancel = undefined;

    mockElectronApi = {
      onCredentialRequest: (cb: (_event: unknown, data: PendingCredentialRequest) => void) => {
        credentialCallback = cb;
        return () => {
          credentialCallback = null;
        };
      },
      submitCredential: mockSubmitCredential,
      cancelCredential: mockCancelCredential,
    };
    mockCreateSecret.mockResolvedValue({ secretId: "secret-123" });
  });

  it("renders CredentialModal closed initially", () => {
    render(<CredentialRequestLayer />);
    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("provider")).toHaveTextContent("");
  });

  it("opens modal when credential request arrives", () => {
    render(<CredentialRequestLayer />);

    act(() => {
      credentialCallback?.(null, {
        requestId: "req-1",
        provider: "openai",
        label: "My Key",
        description: "Enter your OpenAI key",
        placeholder: "sk-...",
      });
    });

    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("provider")).toHaveTextContent("openai");
    expect(screen.getByTestId("label")).toHaveTextContent("My Key");
    expect(screen.getByTestId("description")).toHaveTextContent("Enter your OpenAI key");
    expect(screen.getByTestId("placeholder")).toHaveTextContent("sk-...");
  });

  it("submits credential and closes modal", async () => {
    render(<CredentialRequestLayer />);

    act(() => {
      credentialCallback?.(null, {
        requestId: "req-1",
        provider: "openai",
      });
    });

    expect(capturedOnSubmit).toBeDefined();
    await act(async () => {
      await capturedOnSubmit!({ label: "My API Key", secret: "sk-abc123" });
    });

    expect(mockCreateSecret).toHaveBeenCalledWith({
      provider: "openai",
      label: "My API Key",
      plaintext: "sk-abc123",
    });

    expect(mockSubmitCredential).toHaveBeenCalledWith({
      requestId: "req-1",
      secretId: "secret-123",
      provider: "openai",
      label: "My API Key",
    });

    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "false");
  });

  it("cancels credential request and closes modal", async () => {
    render(<CredentialRequestLayer />);

    act(() => {
      credentialCallback?.(null, {
        requestId: "req-2",
        provider: "anthropic",
      });
    });

    expect(capturedOnCancel).toBeDefined();
    await act(async () => {
      capturedOnCancel!();
    });

    expect(mockCancelCredential).toHaveBeenCalledWith({ requestId: "req-2" });
    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "false");
  });

  it("does not crash when electronAPI is not available", () => {
    mockElectronApi = undefined;
    render(<CredentialRequestLayer />);
    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "false");
  });

  it("does not crash when onCredentialRequest is not available", () => {
    mockElectronApi = {};
    render(<CredentialRequestLayer />);
    expect(screen.getByTestId("credential-modal")).toHaveAttribute("data-open", "false");
  });

  it("unsubscribes from credential request on unmount", () => {
    const unsubscribe = vi.fn();
    mockElectronApi = {
      onCredentialRequest: () => unsubscribe,
    };

    const { unmount } = render(<CredentialRequestLayer />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
