import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalPreferences,
  normalizeImageGenerationPreferences,
  normalizeRealtimeVoicePreferences,
  resolveRealtimeUnderlyingProvider,
  resolveRealtimeVoiceId,
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
        provider: "xai",
        model: " grok-voice-think-fast-1.0 ",
      }),
    ).toEqual({
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
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

  it("preserves per-provider voice ids and resolves them by underlying provider", () => {
    const stellaHome = makeStellaHome();

    const saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: {
        provider: "xai",
        voices: { openai: "verse", xai: "rex" },
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "xai",
      voices: { openai: "verse", xai: "rex" },
    });
    expect(loadLocalPreferences(stellaHome).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    // Resolver picks per underlying provider — stella mode (which mints
    // openai tokens) reads `openai`, xai mode reads `xai`.
    expect(
      resolveRealtimeVoiceId(saved.realtimeVoice, "openai", "marin"),
    ).toEqual("verse");
    expect(resolveRealtimeVoiceId(saved.realtimeVoice, "xai", "eve")).toEqual(
      "rex",
    );

    // Falls back when no voice stored for that provider.
    expect(
      resolveRealtimeVoiceId(
        { provider: "stella", voices: { xai: "rex" } },
        "openai",
        "marin",
      ),
    ).toEqual("marin");
  });

  it("drops invalid voice entries on normalize but keeps valid ones", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        voices: { openai: " marin ", xai: "", extra: "ignored" },
      }),
    ).toEqual({
      provider: "stella",
      voices: { openai: "marin" },
    });
  });

  it("persists stellaSubProvider and resolves the underlying provider", () => {
    const stellaHome = makeStellaHome();

    const saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: {
        provider: "stella",
        voices: { openai: "verse", xai: "rex" },
        stellaSubProvider: "xai",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      voices: { openai: "verse", xai: "rex" },
      stellaSubProvider: "xai",
    });
    expect(loadLocalPreferences(stellaHome).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    expect(resolveRealtimeUnderlyingProvider(saved.realtimeVoice)).toEqual(
      "xai",
    );
    expect(
      resolveRealtimeUnderlyingProvider({ provider: "stella" }),
    ).toEqual("openai");
    expect(
      resolveRealtimeUnderlyingProvider({
        provider: "openai",
        stellaSubProvider: "xai",
      }),
    ).toEqual("openai"); // BYOK modes ignore stellaSubProvider
    expect(
      resolveRealtimeUnderlyingProvider({ provider: "xai" }),
    ).toEqual("xai");
  });

  it("drops invalid stellaSubProvider values", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        stellaSubProvider: "garbage",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("clamps and persists inworldSpeed", () => {
    const stellaHome = makeStellaHome();

    // In-range values round-trip unchanged.
    let saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: { provider: "stella", inworldSpeed: 1.25 },
    });
    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      inworldSpeed: 1.25,
    });

    // Below range → clamped to 0.5.
    saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: { provider: "stella", inworldSpeed: 0.1 },
    });
    expect(saved.realtimeVoice.inworldSpeed).toEqual(0.5);

    // Above range → clamped to 2.0.
    saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: { provider: "stella", inworldSpeed: 5 },
    });
    expect(saved.realtimeVoice.inworldSpeed).toEqual(2.0);

    // Non-numeric → dropped silently.
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        inworldSpeed: "fast" as unknown as number,
      }),
    ).toEqual({ provider: "stella" });
  });

  it("persists Inworld provider + voices + stellaSubProvider", () => {
    const stellaHome = makeStellaHome();

    const saved = updateLocalModelPreferences(stellaHome, {
      realtimeVoice: {
        provider: "stella",
        voices: { openai: "marin", xai: "rex", inworld: "Sarah" },
        stellaSubProvider: "inworld",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      voices: { openai: "marin", xai: "rex", inworld: "Sarah" },
      stellaSubProvider: "inworld",
    });
    expect(loadLocalPreferences(stellaHome).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    expect(resolveRealtimeUnderlyingProvider(saved.realtimeVoice)).toEqual(
      "inworld",
    );
    expect(
      resolveRealtimeVoiceId(saved.realtimeVoice, "inworld", "Clive"),
    ).toEqual("Sarah");

    // Inworld BYOK mode pins to inworld regardless of stellaSubProvider.
    expect(
      resolveRealtimeUnderlyingProvider({
        provider: "inworld",
        stellaSubProvider: "openai",
      }),
    ).toEqual("inworld");
  });
});
