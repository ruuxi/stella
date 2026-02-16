import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MiniShell } from "./MiniShell";

const mockSetWindow = vi.fn();

vi.mock("../../app/state/ui-state", () => ({
  useUiState: () => ({ setWindow: mockSetWindow }),
}));

const contextCaptureDefaults = {
  chatContext: null as any,
  setChatContext: vi.fn(),
  selectedText: null as string | null,
  setSelectedText: vi.fn(),
  shellVisible: false,
  previewIndex: null as number | null,
  setPreviewIndex: vi.fn(),
};

let contextCaptureOverrides: Partial<typeof contextCaptureDefaults> = {};

vi.mock("./use-context-capture", () => ({
  useContextCapture: () => ({ ...contextCaptureDefaults, ...contextCaptureOverrides }),
}));

const miniChatDefaults = {
  message: "",
  setMessage: vi.fn(),
  streamingText: "",
  reasoningText: "",
  pendingUserMessageId: null as string | null,
  events: [] as any[],
  sendMessage: vi.fn(),
};

let miniChatOverrides: Partial<typeof miniChatDefaults> = {};

vi.mock("./use-mini-chat", () => ({
  useMiniChat: () => ({ ...miniChatDefaults, ...miniChatOverrides }),
}));

vi.mock("./MiniInput", () => ({
  MiniInput: () => <div data-testid="mini-input" />,
}));

vi.mock("./MiniOutput", () => ({
  MiniOutput: () => <div data-testid="mini-output" />,
}));

vi.mock("../../components/StellaAnimation", () => ({
  StellaAnimation: () => <div data-testid="stella-animation" />,
}));

describe("MiniShell", () => {
  beforeEach(() => {
    contextCaptureOverrides = {};
    miniChatOverrides = {};
    mockSetWindow.mockReset();
  });

  it("renders with class raycast-shell", () => {
    const { container } = render(<MiniShell />);
    expect(container.querySelector(".raycast-shell")).toBeTruthy();
  });

  it('shows "Stella" as default title when no window context', () => {
    render(<MiniShell />);
    expect(screen.getByText("Stella")).toBeTruthy();
  });

  it("shows window title from chatContext when available", () => {
    contextCaptureOverrides = {
      chatContext: {
        window: { title: "My App Window", app: "SomeApp", bounds: { x: 0, y: 0, width: 800, height: 600 } },
      },
    };
    render(<MiniShell />);
    expect(screen.getByText("My App Window")).toBeTruthy();
  });

  it("renders MiniInput and MiniOutput", () => {
    render(<MiniShell />);
    expect(screen.getByTestId("mini-input")).toBeTruthy();
    expect(screen.getByTestId("mini-output")).toBeTruthy();
  });

  it('shows expand button that calls setWindow("full")', () => {
    render(<MiniShell />);
    const expandButton = screen.getByTitle("Expand to full view");
    fireEvent.click(expandButton);
    expect(mockSetWindow).toHaveBeenCalledWith("full");
  });

  it("shows screenshot preview overlay when previewIndex is set with screenshots", () => {
    contextCaptureOverrides = {
      chatContext: {
        window: null,
        regionScreenshots: [
          { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
        ],
      },
      previewIndex: 0,
    };
    render(<MiniShell />);
    expect(screen.getByAltText("Screenshot preview")).toBeTruthy();
  });

  it("has is-visible class when shellVisible", () => {
    contextCaptureOverrides = { shellVisible: true };
    const { container } = render(<MiniShell />);
    const shell = container.querySelector(".raycast-shell")!;
    expect(shell.classList.contains("is-visible")).toBe(true);
  });
});
