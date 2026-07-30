import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReasoningEffort,
  loadLocalPreferences,
  normalizeImageGenerationPreferences,
  normalizeRealtimeVoicePreferences,
  resolveRealtimeUnderlyingProvider,
  resolveRealtimeVoiceId,
  updateLocalModelPreferences,
} from "../../../../runtime/kernel/preferences/local-preferences.js";
import {
  cleanupRetiredLocalLlmOAuthCredentials,
  getLlmOAuthCredentialStorePath,
  listLocalLlmOAuthCredentials,
} from "../../../../runtime/kernel/storage/llm-oauth-credentials.js";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const makeStellaDataDir = () => tempDirs.create("stella-local-preferences-");

const writePreferences = (
  stellaDataDir: string,
  preferences: Record<string, unknown>,
) => {
  fs.mkdirSync(stellaDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(stellaDataDir, "preferences.json"),
    JSON.stringify(preferences),
  );
};

describe("loadLocalPreferences", () => {
  it("starts new users on low and keeps missing persisted preferences at the medium-producing default", () => {
    const newUserHome = makeStellaDataDir();
    expect(getReasoningEffort(newUserHome, "orchestrator")).toBe("low");
    expect(getReasoningEffort(newUserHome, "general")).toBe("low");

    const legacyHome = makeStellaDataDir();
    writePreferences(legacyHome, {});
    expect(getReasoningEffort(legacyHome, "orchestrator")).toBe("default");
    expect(getReasoningEffort(legacyHome, "general")).toBe("default");

    const customizedHome = makeStellaDataDir();
    writePreferences(customizedHome, {
      reasoningEfforts: { orchestrator: "high" },
    });

    expect(getReasoningEffort(customizedHome, "orchestrator")).toBe("high");
    expect(getReasoningEffort(customizedHome, "general")).toBe("default");
  });

  it("persists engine-scoped Stella state and normalizes Claude minimal", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      stellaConversationModelOverrides: {
        orchestrator: " anthropic/claude-opus-4.8 ",
      },
      stellaConversationReasoningEfforts: { orchestrator: "high" },
      claudeCodeReasoningEffort: "minimal",
    });
    const loaded = loadLocalPreferences(stellaDataDir);
    expect(loaded.stellaConversationModelOverrides).toEqual({
      orchestrator: "anthropic/claude-opus-4.8",
    });
    expect(loaded.stellaConversationReasoningEfforts).toEqual({
      orchestrator: "high",
    });
    expect(loaded.claudeCodeReasoningEffort).toBe("low");
  });
  it("defaults wake-word listening off when the preference is missing", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).wakeWordEnabled).toBe(false);
  });

  it("preserves an explicit wake-word preference", () => {
    const enabledHome = makeStellaDataDir();
    writePreferences(enabledHome, { wakeWordEnabled: true });

    expect(loadLocalPreferences(enabledHome).wakeWordEnabled).toBe(true);

    const disabledHome = makeStellaDataDir();
    writePreferences(disabledHome, { wakeWordEnabled: false });

    expect(loadLocalPreferences(disabledHome).wakeWordEnabled).toBe(false);
  });

  it("defaults image generation to Stella", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).imageGeneration).toEqual({
      provider: "stella",
    });
  });

  it("drops the legacy Stella default model from saved model preferences", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      defaultModels: {
        orchestrator: "stella/default",
        chronicle: " stella/light ",
      },
      modelOverrides: {
        orchestrator: "stella/default",
        general: " stella/standard ",
        empty: " ",
      },
    });

    expect(loadLocalPreferences(stellaDataDir).defaultModels).toEqual({
      chronicle: "stella/light",
    });
    expect(loadLocalPreferences(stellaDataDir).modelOverrides).toEqual({
      general: "stella/standard",
    });

    const saved = updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        orchestrator: "stella/default",
        general: "stella/standard",
      },
    });
    expect(saved.modelOverrides).toEqual({ general: "stella/standard" });
  });

  it("drops saved model selections for retired Google subscription providers", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      defaultModels: {
        orchestrator: "google-gemini-cli/gemini-3-pro-preview",
        general: "stella/standard",
      },
      modelOverrides: {
        orchestrator: "google-antigravity/gemini-3.1-pro-high",
        general: "anthropic/claude-opus-4.8",
      },
      stellaConversationModelOverrides: {
        orchestrator: "google-antigravity/claude-sonnet-4-6",
        general: "stella/priority",
      },
    });

    const loaded = loadLocalPreferences(stellaDataDir);
    expect(loaded.defaultModels).toEqual({ general: "stella/standard" });
    expect(loaded.modelOverrides).toEqual({
      general: "anthropic/claude-opus-4.8",
    });
    expect(loaded.stellaConversationModelOverrides).toEqual({
      general: "stella/priority",
    });
  });

  it("removes stored OAuth records for retired Google subscription providers", () => {
    const stellaDataDir = makeStellaDataDir();
    fs.mkdirSync(stellaDataDir, { recursive: true });
    fs.writeFileSync(
      getLlmOAuthCredentialStorePath(stellaDataDir),
      JSON.stringify({
        version: 1,
        credentials: {
          "google-gemini-cli": {
            provider: "google-gemini-cli",
            label: "Gemini CLI",
            valueProtected: "retired-gemini-credential",
            createdAt: 1,
            updatedAt: 1,
          },
          "google-antigravity": {
            provider: "google-antigravity",
            label: "Google Antigravity",
            valueProtected: "retired-antigravity-credential",
            createdAt: 1,
            updatedAt: 1,
          },
          anthropic: {
            provider: "anthropic",
            label: "Anthropic",
            valueProtected: "supported-credential",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
    );

    cleanupRetiredLocalLlmOAuthCredentials(stellaDataDir);
    expect(listLocalLlmOAuthCredentials(stellaDataDir)).toEqual([
      {
        provider: "anthropic",
        label: "Anthropic",
        status: "active",
        updatedAt: 1,
      },
    ]);
    const persisted = JSON.parse(
      fs.readFileSync(getLlmOAuthCredentialStorePath(stellaDataDir), "utf-8"),
    ) as { credentials: Record<string, unknown> };
    expect(Object.keys(persisted.credentials)).toEqual(["anthropic"]);
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
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      imageGeneration: {
        provider: "fal",
        model: "fal/openai/gpt-image-2",
      },
    });

    expect(saved.imageGeneration).toEqual({
      provider: "fal",
      model: "fal/openai/gpt-image-2",
    });
    expect(loadLocalPreferences(stellaDataDir).imageGeneration).toEqual(
      saved.imageGeneration,
    );
  });

  it("preserves the Codex runtime engine preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      agentRuntimeEngine: "codex_cli",
    });

    expect(saved.agentRuntimeEngine).toBe("codex_cli");
    expect(loadLocalPreferences(stellaDataDir).agentRuntimeEngine).toBe(
      "codex_cli",
    );
  });

  it("preserves the Codex model preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      codexModel: "custom-codex-model",
    });

    expect(saved.codexModel).toBe("custom-codex-model");
    expect(loadLocalPreferences(stellaDataDir).codexModel).toBe(
      "custom-codex-model",
    );
  });

  it("preserves the Codex reasoning preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      codexReasoningEffort: "high",
    });

    expect(saved.codexReasoningEffort).toBe("high");
    expect(loadLocalPreferences(stellaDataDir).codexReasoningEffort).toBe(
      "high",
    );
  });

  it("defaults ChatGPT speed to Standard and persists Fast", () => {
    const defaultHome = makeStellaDataDir();
    expect(loadLocalPreferences(defaultHome).codexServiceTier).toBe("standard");

    const saved = updateLocalModelPreferences(defaultHome, {
      codexServiceTier: "fast",
    });
    expect(saved.codexServiceTier).toBe("fast");
    expect(loadLocalPreferences(defaultHome).codexServiceTier).toBe("fast");

    const invalidHome = makeStellaDataDir();
    writePreferences(invalidHome, { codexServiceTier: "priority" });
    expect(loadLocalPreferences(invalidHome).codexServiceTier).toBe("standard");
  });

  it("preserves the Claude Code model preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      claudeCodeModel: "sonnet[1m]",
    });

    expect(saved.claudeCodeModel).toBe("sonnet[1m]");
    expect(loadLocalPreferences(stellaDataDir).claudeCodeModel).toBe(
      "sonnet[1m]",
    );
  });

  it("defaults realtime voice to Stella", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual({
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
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "openai",
        model: "openai/gpt-realtime",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "openai",
      model: "openai/gpt-realtime",
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );
  });

  it("preserves per-provider voice ids and resolves them by underlying provider", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "xai",
        voices: { openai: "verse", xai: "rex" },
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "xai",
      voices: { openai: "verse", xai: "rex" },
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
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
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
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
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    expect(resolveRealtimeUnderlyingProvider(saved.realtimeVoice)).toEqual(
      "xai",
    );
    expect(resolveRealtimeUnderlyingProvider({ provider: "stella" })).toEqual(
      "openai",
    );
    expect(
      resolveRealtimeUnderlyingProvider({
        provider: "openai",
        stellaSubProvider: "xai",
      }),
    ).toEqual("openai"); // BYOK modes ignore stellaSubProvider
    expect(resolveRealtimeUnderlyingProvider({ provider: "xai" })).toEqual(
      "xai",
    );
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
    const stellaDataDir = makeStellaDataDir();

    // In-range values round-trip unchanged.
    let saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: { provider: "stella", inworldSpeed: 1.25 },
    });
    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      inworldSpeed: 1.25,
    });

    // Below range → clamped to 0.5.
    saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: { provider: "stella", inworldSpeed: 0.1 },
    });
    expect(saved.realtimeVoice.inworldSpeed).toEqual(0.5);

    // Above range → clamped to 2.0.
    saved = updateLocalModelPreferences(stellaDataDir, {
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
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
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
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
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
