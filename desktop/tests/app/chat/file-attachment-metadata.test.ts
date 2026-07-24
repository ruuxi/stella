import { describe, expect, it } from "vitest";
import { buildAllLocalAttachments } from "@/features/chat/streaming/message-context";
import type { ChatContext } from "@/shared/types/electron";

const baseContext: ChatContext = {
  window: null,
} as unknown as ChatContext;

describe("composer file attachment payload", () => {
  it("carries name/size/kind/path so the sent row can render a real file chip", () => {
    const context = {
      ...baseContext,
      files: [
        {
          name: "resume.pdf",
          size: 48_128,
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,cGRm",
          path: "/Users/example/Documents/resume.pdf",
        },
      ],
    } as ChatContext;

    expect(buildAllLocalAttachments(context)).toEqual([
      {
        url: "data:application/pdf;base64,cGRm",
        mimeType: "application/pdf",
        name: "resume.pdf",
        size: 48_128,
        kind: "file",
        path: "/Users/example/Documents/resume.pdf",
      },
    ]);
  });

  it("omits path for synthetic files with no on-disk source", () => {
    const context = {
      ...baseContext,
      files: [
        {
          name: "notes.txt",
          size: 12,
          mimeType: "text/plain",
          dataUrl: "data:text/plain;base64,bm90ZXM=",
        },
      ],
    } as ChatContext;

    const [attachment] = buildAllLocalAttachments(context);
    expect(attachment.name).toBe("notes.txt");
    expect(attachment.kind).toBe("file");
    expect("path" in attachment).toBe(false);
  });
});
