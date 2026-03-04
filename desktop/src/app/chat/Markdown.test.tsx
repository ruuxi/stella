import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    className,
    isAnimating,
    remarkPlugins,
    components,
  }: {
    children: string;
    className?: string;
    isAnimating?: boolean;
    remarkPlugins?: unknown[];
    components?: Record<string, unknown>;
  }) => (
    <div
      data-testid="streamdown"
      className={className}
      data-animating={isAnimating ? "true" : "false"}
      data-has-plugins={remarkPlugins ? "true" : "false"}
      data-has-components={components ? "true" : "false"}
    >
      {children}
    </div>
  ),
}));

const mockUseEmojiEmoteLookup = vi.fn((_enabled?: boolean) => new Map());
vi.mock("./emotes/twitch-emotes", () => ({
  useEmojiEmoteLookup: (...args: unknown[]) => mockUseEmojiEmoteLookup(...(args as [boolean])),
}));

const mockCreatePlugin = vi.fn((_lookup?: Map<string, string>) => () => (tree: unknown) => tree);
vi.mock("./emotes/remark-twitch-emotes", () => ({
  createTwitchEmoteRemarkPlugin: (...args: unknown[]) => mockCreatePlugin(...(args as [Map<string, string>])),
  isMarkedEmoteUrl: vi.fn((url: string) => url.includes("#stella-emote")),
  stripEmoteUrlMarker: vi.fn((url: string) => url.replace("#stella-emote", "")),
}));

vi.mock("./markdown.css", () => ({}));

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders text content", () => {
    render(<Markdown text="Hello world" />);
    const el = screen.getByTestId("streamdown");
    expect(el.textContent).toBe("Hello world");
  });

  it("passes className to Streamdown", () => {
    render(<Markdown text="test" className="custom-class" />);
    const el = screen.getByTestId("streamdown");
    expect(el.className).toContain("custom-class");
  });

  it("passes isAnimating to Streamdown", () => {
    render(<Markdown text="test" isAnimating={true} />);
    const el = screen.getByTestId("streamdown");
    expect(el.getAttribute("data-animating")).toBe("true");
  });

  it("applies 'markdown' base class", () => {
    render(<Markdown text="test" />);
    const el = screen.getByTestId("streamdown");
    expect(el.className).toContain("markdown");
  });

  it("does not create remarkPlugin when emotes disabled", () => {
    mockCreatePlugin.mockClear();
    render(<Markdown text="test" enableEmotes={false} />);
    expect(mockCreatePlugin).not.toHaveBeenCalled();
    const el = screen.getByTestId("streamdown");
    expect(el.getAttribute("data-has-plugins")).toBe("false");
  });

  it("creates remarkPlugin when emotes enabled with lookup", () => {
    mockCreatePlugin.mockClear();
    const emoteMap = new Map([["Kappa", "https://emote.url/kappa.png"]]);
    mockUseEmojiEmoteLookup.mockReturnValue(emoteMap);

    render(<Markdown text="test" enableEmotes={true} />);
    expect(mockCreatePlugin).toHaveBeenCalledWith(emoteMap);
    const el = screen.getByTestId("streamdown");
    expect(el.getAttribute("data-has-plugins")).toBe("true");

    // Reset to default
    mockUseEmojiEmoteLookup.mockReturnValue(new Map());
  });

  it("does not create remarkPlugin when emotes enabled but lookup is empty", () => {
    mockCreatePlugin.mockClear();
    mockUseEmojiEmoteLookup.mockReturnValue(new Map());

    render(<Markdown text="test" enableEmotes={true} />);
    expect(mockCreatePlugin).not.toHaveBeenCalled();
    const el = screen.getByTestId("streamdown");
    expect(el.getAttribute("data-has-plugins")).toBe("false");
  });

  it("defaults isAnimating to false", () => {
    render(<Markdown text="test" />);
    const el = screen.getByTestId("streamdown");
    expect(el.getAttribute("data-animating")).toBe("false");
  });
});
