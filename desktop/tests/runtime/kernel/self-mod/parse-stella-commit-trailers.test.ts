import { describe, expect, it } from "vitest";
import { parseStellaCommitTrailers } from "../../../../../runtime/kernel/self-mod/git.js";

describe("parseStellaCommitTrailers", () => {
  it("returns empty parents for a body with no trailers", () => {
    const result = parseStellaCommitTrailers("just a regular commit body\nwith no trailers");
    expect(result.conversationId).toBeUndefined();
    expect(result.packageId).toBeUndefined();
    expect(result.featureId).toBeUndefined();
    expect(result.featureTitle).toBeUndefined();
    expect(result.parentPackageIds).toEqual([]);
  });

  it("reads the existing conversation + package trailers", () => {
    const result = parseStellaCommitTrailers(
      [
        "Self mod update",
        "",
        "Stella-Conversation: cv_abc123",
        "Stella-Package-Id: notes-page",
      ].join("\n"),
    );
    expect(result.conversationId).toBe("cv_abc123");
    expect(result.packageId).toBe("notes-page");
  });

  it("reads the new feature trailers", () => {
    const result = parseStellaCommitTrailers(
      [
        "Self mod update",
        "",
        "Stella-Feature-Id: feat:nB8x9k",
        "Stella-Feature-Title: Snake game",
      ].join("\n"),
    );
    expect(result.featureId).toBe("feat:nB8x9k");
    expect(result.featureTitle).toBe("Snake game");
  });

  it("collects multiple `Stella-Parent-Package-Id` trailers in order", () => {
    const result = parseStellaCommitTrailers(
      [
        "Self mod update",
        "",
        "Stella-Parent-Package-Id: snake-game",
        "Stella-Parent-Package-Id: dark-theme",
      ].join("\n"),
    );
    expect(result.parentPackageIds).toEqual(["snake-game", "dark-theme"]);
  });

  it("ignores blank trailer values without crashing", () => {
    const result = parseStellaCommitTrailers(
      [
        "subject",
        "",
        "Stella-Feature-Id: ",
        "Stella-Feature-Title: Snake",
      ].join("\n"),
    );
    expect(result.featureId).toBeUndefined();
    expect(result.featureTitle).toBe("Snake");
  });

  it("trims surrounding whitespace from values", () => {
    const result = parseStellaCommitTrailers("Stella-Feature-Id:    feat:abc   ");
    expect(result.featureId).toBe("feat:abc");
  });

  it("ignores non-Stella trailer-shaped lines (e.g. Signed-off-by)", () => {
    const result = parseStellaCommitTrailers(
      [
        "subject",
        "",
        "Signed-off-by: someone",
        "Stella-Feature-Id: feat:abc",
      ].join("\n"),
    );
    expect(result.featureId).toBe("feat:abc");
  });
});
