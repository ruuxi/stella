import { describe, test, expect } from "bun:test";
import {
  VOICE_ORCHESTRATOR_PROMPT,
  buildVoiceSessionInstructions,
} from "../convex/prompts/voice_orchestrator";

describe("buildVoiceSessionInstructions", () => {
  test("includes base prompt", () => {
    const result = buildVoiceSessionInstructions({});
    expect(result).toContain("Stella");
    expect(result).toContain("voice mode");
  });

  test("includes user name when provided", () => {
    const result = buildVoiceSessionInstructions({ userName: "Alice" });
    expect(result).toContain("Alice");
  });

  test("includes platform when provided", () => {
    const result = buildVoiceSessionInstructions({ platform: "macOS" });
    expect(result).toContain("macOS");
  });

  test("includes device status when provided", () => {
    const result = buildVoiceSessionInstructions({
      deviceStatus: "Device is online",
    });
    expect(result).toContain("Device is online");
  });

  test("includes active threads when provided", () => {
    const result = buildVoiceSessionInstructions({
      activeThreads: "Thread: Project Setup",
    });
    expect(result).toContain("Project Setup");
  });

  test("includes user profile section when provided", () => {
    const result = buildVoiceSessionInstructions({
      userProfile: "User is a developer",
    });
    expect(result).toContain("User Profile");
    expect(result).toContain("User is a developer");
  });

  test("omits sections for undefined fields", () => {
    const result = buildVoiceSessionInstructions({});
    expect(result).not.toContain("User Profile");
    expect(result).not.toContain("undefined");
  });

  test("combines all sections", () => {
    const result = buildVoiceSessionInstructions({
      userName: "Bob",
      platform: "Windows",
      userProfile: "Prefers TypeScript",
    });
    expect(result).toContain("Bob");
    expect(result).toContain("Windows");
    expect(result).toContain("Prefers TypeScript");
  });
});
