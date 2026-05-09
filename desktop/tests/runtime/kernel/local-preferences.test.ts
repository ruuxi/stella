import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalPreferences,
  normalizeImageGenerationPreferences,
  normalizeRealtimeVoicePreferences,
  updateLocalModelPreferences,
} from "../../../../runtime/kernel/preferences/local-preferences.js";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const makeStellaHome = () => tempDirs.create("stella-local-preferences-");

const writePreferences = (
  stellaHome: string,
  preferences: Record<string, unknown>,
) => {
  const stateDir = path.join(stellaHome, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "preferences.json"),
    JSON.stringify(preferences),
  );
};

describe("loadLocalPreferences", () => {
  it("defaults wake-word listening off when the preference is missing", () => {
    const stellaHome = makeStellaHome();
    writePreferences(stellaHome, {});

    expect(loadLocalPreferences(stellaHome).wakeWordEnabled).toBe(false);
  });

  it("preserves an explicit wake-word preference", () => {
    const enabledHome = makeStellaHome();
    writePreferences(enabledHome, { wakeWordEnabled: true });

    expect(loadLocalPreferences(enabledHome).wakeWordEnabled).toBe(true);

    const disabledHome = makeStellaHome();
    writePreferences(disabledHome, { wakeWordEnabled: false });

    expect(loadLocalPreferences(disabledHome).wakeWordEnabled).toBe(false);
  });

  it("defaults image generation to Stella", () => {
    const stellaHome = makeStellaHome();
    writePreferences(stellaHome, {});

    expect(loadLocalPreferences(stellaHome).imageGeneration).toEqual({
      provider: "stella",
    });
  });

  it("normalizes direct image provider preferences", () => {
    expect(
      normalizeImageGenerationPreferences({
        provider: "openai",
        model: " openai/gpt-image-1.5 ",
      }),
    ).toEqual({
      provider: "openai",
      model: "openai/gpt-image-1.5",
    });
    expect(
      normalizeImageGenerationPreferences({
        provider: "unknown",
        model: "openai/gpt-image-1.5",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("saves image generation in the model preference snapshot", () => {
    const stellaHome = makeStellaHome();

    const saved = updateLocalModelPreferences(stellaHome, {
      imageGeneration: {
        provider: "fal",
        model: "fal/openai/gpt-image-2",
      },
    });

    expect(saved.imageGeneration).toEqual({
      provider: "fal",
      model: "fal/openai/gpt-image-2",
    });
    expect(loadLocalPreferences(stellaHome).imageGeneration).toEqual(
      saved.imageGeneration,
    );
  });

  it("defaults realtime voice to Stella", () => {
    const stellaHome = makeStellaHome();
    writePreferences(stellaHome, {});

    expect(loadLocalPreferences(stellaHome).realtimeVoice).toEqual({
      provider: "stella",
    });
  });

  it("normalizes direct realtime voice preferences", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "openai",
        model: " openai/gpt-realtime ",
      }),
    ).toEqual({
      provider: "openai",
      model: "openai/gpt-realtime",
    });
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "fal",
        model: "openai/gpt-realtime",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("saves realtime voice in the model preference snapshot", () => {
    const stellaHome = makeStellaHome();

    const saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: {
        provider: "openai",
        model: "openai/gpt-realtime",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "openai",
      model: "openai/gpt-realtime",
    });
    expect(loadLocalPreferences(stellaHome).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );
  });
});
