import { describe, expect, it } from "vitest";
import { toCloudConversationId } from "./conversation-id";

describe("toCloudConversationId", () => {
  it("returns null for nullish values", () => {
    expect(toCloudConversationId(null)).toBeNull();
    expect(toCloudConversationId(undefined)).toBeNull();
  });

  it("rejects local ULID-like conversation ids", () => {
    expect(toCloudConversationId("01KHVRH3ZAPQN48JWYNJNYDCVC")).toBeNull();
  });

  it("keeps non-ULID ids", () => {
    expect(toCloudConversationId("k17f5x7na4zv5v9s9f5r9c5n7h7c0h4c")).toBe(
      "k17f5x7na4zv5v9s9f5r9c5n7h7c0h4c",
    );
    expect(toCloudConversationId("conv-1")).toBe("conv-1");
  });
});

