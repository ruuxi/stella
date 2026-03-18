import { describe, expect, test } from "bun:test";
import {
  MEDIA_JOB_STATUS_VALUES,
  createMediaGenerateRequestExample,
  createMediaGenerateAcceptedResponse,
  createMediaJobError,
  createMediaJobResponse,
  parseMediaGenerateRequest,
} from "../convex/media_contract";

describe("media contract", () => {
  test("publishes the stable job statuses", () => {
    expect(MEDIA_JOB_STATUS_VALUES).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ]);
  });

  test("parses the canonical generate request shape", () => {
    expect(
      parseMediaGenerateRequest({
        capability: " text_to_image ",
        profile: " BEST ",
        prompt: "  neon city  ",
        aspectRatio: " 16:9 ",
        sourceUrl: " https://example.com/source.png ",
        source: " data:image/png;base64,aGVsbG8= ",
        sources: {
          video: " data:video/mp4;base64,dm1wNA== ",
          audio: {
            mimeType: " audio/wav ",
            base64: " YXVkaW8= ",
          },
        },
        input: {
          image_size: "portrait_16_9",
        },
      }),
    ).toEqual({
      capability: "text_to_image",
      profile: "best",
      prompt: "neon city",
      aspectRatio: "16:9",
      sourceUrl: "https://example.com/source.png",
      source: "data:image/png;base64,aGVsbG8=",
      sources: {
        video: "data:video/mp4;base64,dm1wNA==",
        audio: {
          mimeType: "audio/wav",
          base64: "YXVkaW8=",
        },
      },
      input: {
        image_size: "portrait_16_9",
      },
    });
  });

  test("rejects generate requests without a capability", () => {
    expect(
      parseMediaGenerateRequest({
        prompt: "missing capability",
      }),
    ).toBeNull();
  });

  test("builds the canonical generate request example", () => {
    expect(
      createMediaGenerateRequestExample({
        capability: "image_to_video",
        profile: "motion",
        prompt: "cinematic shot",
        aspectRatio: "21:9",
        source: "data:image/png;base64,<base64>",
        sources: {
          audio: {
            mimeType: "audio/wav",
            base64: "<base64>",
          },
        },
        input: {
          duration: 5,
        },
      }),
    ).toEqual({
      capability: "image_to_video",
      profile: "motion",
      prompt: "cinematic shot",
      aspectRatio: "21:9",
      source: "data:image/png;base64,<base64>",
      sources: {
        audio: {
          mimeType: "audio/wav",
          base64: "<base64>",
        },
      },
      input: {
        duration: 5,
      },
    });
  });

  test("preserves a malformed source object for backend validation", () => {
    expect(
      parseMediaGenerateRequest({
        capability: "image_to_video",
        source: {
          base64: "aGVsbG8=",
        },
      }),
    ).toEqual({
      capability: "image_to_video",
      source: {
        base64: "aGVsbG8=",
        mimeType: "",
      },
      input: {},
    });
  });

  test("builds the canonical async generate response", () => {
    expect(
      createMediaGenerateAcceptedResponse({
        jobId: "job_123",
        capability: "text_to_image",
        profile: "best",
        status: "queued",
        upstreamStatus: "IN_QUEUE",
        subscription: {
          query: "api.media_jobs.getByJobId",
          args: { jobId: "job_123" },
        },
      }),
    ).toEqual({
      jobId: "job_123",
      capability: "text_to_image",
      profile: "best",
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      subscription: {
        query: "api.media_jobs.getByJobId",
        args: { jobId: "job_123" },
      },
    });
  });

  test("normalizes rich upstream errors into the canonical error shape", () => {
    expect(
      createMediaJobError({
        value: {
          message: "Upstream rejected the request",
          code: "UPSTREAM_REJECTED",
          retryable: false,
        },
      }),
    ).toEqual({
      message: "Upstream rejected the request",
      code: "UPSTREAM_REJECTED",
      details: {
        retryable: false,
      },
    });
  });

  test("builds the canonical job response", () => {
    expect(
      createMediaJobResponse({
        jobId: "job_123",
        capability: "text_to_image",
        profile: "best",
        request: {
          prompt: "cinematic skyline",
          aspectRatio: "9:16",
          source: { kind: "url" },
          input: { image_size: "portrait_16_9" },
        },
        status: "succeeded",
        upstreamStatus: "OK",
        queuePosition: null,
        output: {
          images: [{ url: "https://example.com/output.png" }],
        },
        createdAt: 10,
        updatedAt: 12,
        completedAt: 12,
      }),
    ).toEqual({
      jobId: "job_123",
      capability: "text_to_image",
      profile: "best",
      request: {
        prompt: "cinematic skyline",
        aspectRatio: "9:16",
        source: { kind: "url" },
        input: { image_size: "portrait_16_9" },
      },
      status: "succeeded",
      upstreamStatus: "OK",
      queuePosition: null,
      output: {
        images: [{ url: "https://example.com/output.png" }],
      },
      createdAt: 10,
      updatedAt: 12,
      completedAt: 12,
    });
  });
});
