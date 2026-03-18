import { describe, expect, test } from "bun:test";
import { socialSchema } from "../convex/schema/social";
import {
  getRelationshipKey,
  getSocialSessionConversationId,
  normalizeNickname,
  normalizeRelativeSessionPath,
  sanitizeWorkspaceFolderName,
  sanitizeWorkspaceSlug,
} from "../convex/social/shared";

describe("social schema shape", () => {
  test("exports the expected social tables", () => {
    expect(Object.keys(socialSchema).sort()).toEqual([
      "social_messages",
      "social_profiles",
      "social_relationships",
      "social_room_members",
      "social_rooms",
      "stella_session_file_blobs",
      "stella_session_file_ops",
      "stella_session_files",
      "stella_session_members",
      "stella_session_turns",
      "stella_sessions",
    ]);
  });
});

describe("social helper behavior", () => {
  test("canonicalizes relationship keys", () => {
    expect(getRelationshipKey("user-z", "user-a")).toBe("user-a:user-z");
    expect(getRelationshipKey("user-a", "user-z")).toBe("user-a:user-z");
  });

  test("normalizes nicknames by trimming and collapsing spaces", () => {
    expect(normalizeNickname("  Bright    Harbor   Fox  ")).toBe("Bright Harbor Fox");
  });

  test("sanitizes workspace slugs", () => {
    expect(sanitizeWorkspaceSlug("  Team Alpha / Sprint #1  ")).toBe("team-alpha-sprint-1");
  });

  test("sanitizes workspace folder names", () => {
    expect(sanitizeWorkspaceFolderName('  Team<Alpha>:/Sprint?1...  ')).toBe("Team-Alpha---Sprint-1");
  });

  test("normalizes safe relative paths", () => {
    expect(normalizeRelativeSessionPath(" src\\\\components / App.tsx ")).toBe("src/components/App.tsx");
  });

  test("rejects traversal in relative paths", () => {
    expect(() => normalizeRelativeSessionPath("../secrets.txt")).toThrow();
    expect(() => normalizeRelativeSessionPath("./notes.txt")).toThrow();
  });

  test("creates a stable session conversation id prefix", () => {
    expect(getSocialSessionConversationId("abc123" as never)).toBe("social:stella:abc123");
  });
});
