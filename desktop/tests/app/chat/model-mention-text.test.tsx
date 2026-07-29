// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ComposerModelMentionTextarea,
  ModelMentionText,
} from "@/app/chat/ModelMentionText";

describe("inline model mention presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("highlights valid routes inline while preserving the exact transcript", async () => {
    const text = "Ask @chatgpt, then @claude-code.";
    await act(async () => {
      root.render(
        <div className="event-item user">
          <ModelMentionText text={text} />
        </div>,
      );
    });

    const mentions = Array.from(
      container.querySelectorAll<HTMLElement>(".model-mention-inline"),
    );
    expect(container.textContent).toBe(text);
    expect(mentions.map((mention) => mention.textContent)).toEqual([
      "@chatgpt",
      "@claude-code",
    ]);
    expect(mentions.map((mention) => mention.dataset.modelRoute)).toEqual([
      "codex",
      "claude-code",
    ]);
  });

  it("keeps a native textarea and mirrors its mention styling in place", async () => {
    const text = "@chatgpt explain this";
    await act(async () => {
      root.render(
        <ComposerModelMentionTextarea
          value={text}
          onChange={() => undefined}
        />,
      );
    });

    const textarea = container.querySelector("textarea");
    const mirror = container.querySelector(".composer-model-mention-mirror");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe(text);
    expect(mirror?.textContent).toBe(text);
    expect(mirror?.querySelector(".model-mention-inline")?.textContent).toBe(
      "@chatgpt",
    );
  });
});
