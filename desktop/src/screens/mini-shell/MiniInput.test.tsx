import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MiniInput } from "./MiniInput";
import type { ChatContext } from "../../types/electron";

function defaultProps(overrides: Partial<Parameters<typeof MiniInput>[0]> = {}) {
  return {
    message: "",
    setMessage: vi.fn(),
    chatContext: null as ChatContext | null,
    setChatContext: vi.fn(),
    selectedText: null as string | null,
    setSelectedText: vi.fn(),
    previewIndex: null as number | null,
    setPreviewIndex: vi.fn(),
    isStreaming: false,
    shellVisible: true,
    onSend: vi.fn(),
    ...overrides,
  };
}

describe("MiniInput", () => {
  beforeEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders input with default placeholder", () => {
    render(<MiniInput {...defaultProps()} />);
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("shows window badge when chatContext.window is set", () => {
    const chatContext: ChatContext = {
      window: {
        app: "Notepad",
        title: "readme.txt",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(screen.getByText("readme.txt")).toBeTruthy();
  });

  it("shows screenshot thumbnails when regionScreenshots is set", () => {
    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
      ],
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(screen.getByAltText("Screenshot 1")).toBeTruthy();
  });

  it("shows selected text chip when selectedText is set", () => {
    render(<MiniInput {...defaultProps({ selectedText: "hello world" })} />);
    expect(screen.getByText(/hello world/)).toBeTruthy();
  });

  it("calls onSend on Enter key", () => {
    const onSend = vi.fn();
    render(<MiniInput {...defaultProps({ onSend })} />);
    const input = screen.getByPlaceholderText("Ask for follow-up changes");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("calls window.electronAPI.closeWindow on Escape", () => {
    const closeWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { closeWindow };

    render(<MiniInput {...defaultProps()} />);
    const input = screen.getByPlaceholderText("Ask for follow-up changes");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(closeWindow).toHaveBeenCalled();
  });

  it("send button is disabled when no message, selectedText, or screenshots", () => {
    const { container } = render(<MiniInput {...defaultProps()} />);
    const sendBtn = container.querySelector(
      ".mini-composer-send",
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("shows stop button when isStreaming is true", () => {
    const { container } = render(
      <MiniInput {...defaultProps({ isStreaming: true })} />,
    );
    expect(container.querySelector(".mini-composer-stop")).toBeTruthy();
  });

  it("calls setSelectedText(null) on Backspace when message is empty and selectedText exists", () => {
    const setSelectedText = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          message: "",
          selectedText: "some text",
          setSelectedText,
        })}
      />,
    );

    const input = screen.getByPlaceholderText("Ask about the selection...");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(setSelectedText).toHaveBeenCalledWith(null);
  });

  it("dismisses window context when clicking dismiss button", () => {
    const setChatContext = vi.fn();
    const chatContext: ChatContext = {
      window: {
        app: "VSCode",
        title: "index.ts",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    };
    render(
      <MiniInput
        {...defaultProps({ chatContext, setChatContext })}
      />,
    );

    const dismissBtn = screen.getByLabelText("Remove window context");
    fireEvent.click(dismissBtn);
    expect(setChatContext).toHaveBeenCalled();

    // Verify the updater function removes window from context
    const updater = setChatContext.mock.calls[0][0];
    const result = updater({ window: { app: "VSCode", title: "index.ts", bounds: { x: 0, y: 0, width: 800, height: 600 } } });
    expect(result.window).toBeNull();
  });

  it("shows app name as fallback when window title is empty", () => {
    const chatContext: ChatContext = {
      window: {
        app: "Notepad",
        title: "",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(screen.getByText("Notepad")).toBeTruthy();
  });

  it("clicking a screenshot thumbnail calls setPreviewIndex", () => {
    const setPreviewIndex = vi.fn();
    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
      ],
    };
    render(
      <MiniInput
        {...defaultProps({ chatContext, setPreviewIndex })}
      />,
    );
    const thumb = screen.getByAltText("Screenshot 1");
    fireEvent.click(thumb);
    expect(setPreviewIndex).toHaveBeenCalledWith(0);
  });

  it("removes a screenshot when clicking remove button", () => {
    const setChatContext = vi.fn();
    const removeScreenshot = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = { removeScreenshot };

    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
        { dataUrl: "data:image/png;base64,def", width: 200, height: 200 },
      ],
    };
    render(
      <MiniInput
        {...defaultProps({ chatContext, setChatContext })}
      />,
    );

    const removeButtons = screen.getAllByLabelText("Remove screenshot");
    fireEvent.click(removeButtons[0]);

    expect(removeScreenshot).toHaveBeenCalledWith(0);
    expect(setChatContext).toHaveBeenCalled();

    // Verify updater function splices the correct screenshot
    const updater = setChatContext.mock.calls[0][0];
    const result = updater({
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
        { dataUrl: "data:image/png;base64,def", width: 200, height: 200 },
      ],
    });
    expect(result.regionScreenshots).toHaveLength(1);
    expect(result.regionScreenshots[0].dataUrl).toBe("data:image/png;base64,def");
  });

  it("removes selected text chip when clicking remove button", () => {
    const setSelectedText = vi.fn();
    const setChatContext = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          selectedText: "some text",
          setSelectedText,
          setChatContext,
        })}
      />,
    );

    const removeBtn = screen.getByLabelText("Remove selected text");
    fireEvent.click(removeBtn);
    expect(setSelectedText).toHaveBeenCalledWith(null);
    expect(setChatContext).toHaveBeenCalled();

    // Verify updater clears selectedText
    const updater = setChatContext.mock.calls[0][0];
    const result = updater({ selectedText: "some text" });
    expect(result.selectedText).toBeNull();
  });

  it("shows 'Capturing screen...' placeholder when capturePending", () => {
    const chatContext: ChatContext = {
      window: null,
      capturePending: true,
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(
      screen.getByPlaceholderText("Capturing screen..."),
    ).toBeTruthy();
  });

  it("shows pending indicator when capturePending is true", () => {
    const chatContext: ChatContext = {
      window: null,
      capturePending: true,
    };
    const { container } = render(
      <MiniInput {...defaultProps({ chatContext })} />,
    );
    expect(
      container.querySelector(".mini-context-chip--pending"),
    ).toBeTruthy();
  });

  it("shows 'Ask about the capture...' placeholder when screenshots exist", () => {
    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
      ],
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(
      screen.getByPlaceholderText("Ask about the capture..."),
    ).toBeTruthy();
  });

  it("shows 'Ask about this window...' placeholder when window context exists", () => {
    const chatContext: ChatContext = {
      window: {
        app: "Chrome",
        title: "Google",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    };
    render(<MiniInput {...defaultProps({ chatContext })} />);
    expect(
      screen.getByPlaceholderText("Ask about this window..."),
    ).toBeTruthy();
  });

  it("shows 'Ask about the selection...' placeholder when selectedText exists", () => {
    render(
      <MiniInput {...defaultProps({ selectedText: "hello world" })} />,
    );
    expect(
      screen.getByPlaceholderText("Ask about the selection..."),
    ).toBeTruthy();
  });

  it("Escape with previewIndex set calls setPreviewIndex(null) instead of closeWindow", () => {
    const setPreviewIndex = vi.fn();
    const closeWindow = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = { closeWindow };

    render(
      <MiniInput
        {...defaultProps({
          previewIndex: 2,
          setPreviewIndex,
        })}
      />,
    );

    const input = screen.getByPlaceholderText("Ask for follow-up changes");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(setPreviewIndex).toHaveBeenCalledWith(null);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("send button is enabled when there is a message", () => {
    const { container } = render(
      <MiniInput {...defaultProps({ message: "hello" })} />,
    );
    const sendBtn = container.querySelector(
      ".mini-composer-send",
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
  });

  it("send button is enabled when selectedText is set", () => {
    const { container } = render(
      <MiniInput {...defaultProps({ selectedText: "some text" })} />,
    );
    const sendBtn = container.querySelector(
      ".mini-composer-send",
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
  });

  it("send button is enabled when screenshots exist", () => {
    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
      ],
    };
    const { container } = render(
      <MiniInput {...defaultProps({ chatContext })} />,
    );
    const sendBtn = container.querySelector(
      ".mini-composer-send",
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
  });

  it("does not call setSelectedText on Backspace when message is non-empty", () => {
    const setSelectedText = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          message: "has text",
          selectedText: "some text",
          setSelectedText,
        })}
      />,
    );

    const input = screen.getByPlaceholderText("Ask about the selection...");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(setSelectedText).not.toHaveBeenCalled();
  });

  it("Backspace also clears selectedText from chatContext", () => {
    const setSelectedText = vi.fn();
    const setChatContext = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          message: "",
          selectedText: "some text",
          setSelectedText,
          setChatContext,
        })}
      />,
    );

    const input = screen.getByPlaceholderText("Ask about the selection...");
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(setChatContext).toHaveBeenCalled();
    const updater = setChatContext.mock.calls[0][0];
    const result = updater({ selectedText: "some text" });
    expect(result.selectedText).toBeNull();
  });

  it("setChatContext updater returns prev when prev is null (dismiss window)", () => {
    const setChatContext = vi.fn();
    const chatContext: ChatContext = {
      window: {
        app: "App",
        title: "T",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    };
    render(
      <MiniInput {...defaultProps({ chatContext, setChatContext })} />,
    );

    const dismissBtn = screen.getByLabelText("Remove window context");
    fireEvent.click(dismissBtn);
    const updater = setChatContext.mock.calls[0][0];
    expect(updater(null)).toBeNull();
  });

  it("screenshot remove updater handles null prev", () => {
    const setChatContext = vi.fn();
    const removeScreenshot = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = { removeScreenshot };
    const chatContext: ChatContext = {
      window: null,
      regionScreenshots: [
        { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
      ],
    };
    render(
      <MiniInput {...defaultProps({ chatContext, setChatContext })} />,
    );
    const removeBtn = screen.getAllByLabelText("Remove screenshot")[0];
    fireEvent.click(removeBtn);
    const updater = setChatContext.mock.calls[0][0];
    expect(updater(null)).toBeNull();
  });

  it("remove selected text updater handles null prev", () => {
    const setChatContext = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          selectedText: "text",
          setChatContext,
        })}
      />,
    );
    const removeBtn = screen.getByLabelText("Remove selected text");
    fireEvent.click(removeBtn);
    const updater = setChatContext.mock.calls[0][0];
    expect(updater(null)).toBeNull();
  });

  it("Backspace context updater returns prev when prev is null", () => {
    const setChatContext = vi.fn();
    render(
      <MiniInput
        {...defaultProps({
          message: "",
          selectedText: "text",
          setChatContext,
        })}
      />,
    );
    const input = screen.getByPlaceholderText("Ask about the selection...");
    fireEvent.keyDown(input, { key: "Backspace" });
    const updater = setChatContext.mock.calls[0][0];
    expect(updater(null)).toBeNull();
  });

  it("onChange updates message via setMessage", () => {
    const setMessage = vi.fn();
    render(<MiniInput {...defaultProps({ setMessage })} />);
    const input = screen.getByPlaceholderText("Ask for follow-up changes");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(setMessage).toHaveBeenCalledWith("hello");
  });

  it("clicking send button calls onSend", () => {
    const onSend = vi.fn();
    const { container } = render(
      <MiniInput {...defaultProps({ message: "hello", onSend })} />,
    );
    const sendBtn = container.querySelector(
      ".mini-composer-send",
    ) as HTMLButtonElement;
    fireEvent.click(sendBtn);
    expect(onSend).toHaveBeenCalled();
  });
});
