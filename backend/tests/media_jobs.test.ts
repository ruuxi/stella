import { describe, expect, test } from "bun:test";
import { summarizeMediaRequestForStorage } from "../convex/media_jobs";

describe("media job storage summary", () => {
  test("keeps request metadata but omits raw local media payloads", () => {
    expect(
      summarizeMediaRequestForStorage({
        capability: "image_to_video",
        prompt: "animate this image",
        aspectRatio: "16:9",
        source: "data:image/png;base64,aGVsbG8=",
        sources: {
          audio: {
            mimeType: "audio/wav",
            base64: "YXVkaW8=",
          },
        },
        input: {
          image_url: "data:image/png;base64,aGVsbG8=",
          duration: 5,
          nested: {
            reference: "https://example.com/reference.png",
            mask: "data:image/png;base64,bWFzaw==",
          },
        },
      }),
    ).toEqual({
      prompt: "animate this image",
      aspectRatio: "16:9",
      source: {
        kind: "data_uri",
        mimeType: "image/png",
      },
      sources: {
        audio: {
          kind: "base64_object",
          mimeType: "audio/wav",
        },
      },
      input: {
        image_url: "[data-uri omitted]",
        duration: 5,
        nested: {
          reference: "https://example.com/reference.png",
          mask: "[data-uri omitted]",
        },
      },
    });
  });
});
