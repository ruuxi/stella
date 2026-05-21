import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, KeyRound, LogIn } from "lucide-react";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";
import {
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
  type LlmProviderEntry,
} from "@/global/settings/lib/llm-providers";
import {
  findApiKey,
  findOauthCredential,
  findOauthProvider,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";

type EnginePhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type EngineChoice = "stella" | "claude_code" | "byok";

/**
 * Provider keys we surface in the onboarding "Bring your own provider" list.
 * The full catalog lives in `llm-providers.ts` and shows up in
 * Settings → Models. The onboarding tile is a focused subset that lets users
 * sign in / paste a key inline, or skip and configure later.
 */
const BYOK_PROVIDER_KEYS: readonly string[] = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "xai",
  "groq",
  "cerebras",
  "mistral",
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "fal",
];

type ProviderEntry = {
  entry: LlmProviderEntry;
  connected: boolean;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
};

export function OnboardingEnginePhase({
  splitTransitionActive,
  onContinue,
}: EnginePhaseProps) {
  const credentials = useLlmCredentials();

  const [choice, setChoice] = useState<EngineChoice>("stella");
  const [error, setError] = useState<string | null>(null);
  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Seed the selection from the existing engine preference so revisiting
  // the phase reflects the user's prior pick. BYOK is inferred from "any
  // non-Stella API key or OAuth credential is already configured", since
  // the engine itself stays "default" on BYOK.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const prefs =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (cancelled || !prefs) return;
        if (prefs.agentRuntimeEngine === "claude_code_local") {
          setChoice("claude_code");
          return;
        }
        const hasAnyByok =
          credentials.apiKeys.length > 0 ||
          credentials.oauthCredentials.length > 0;
        setChoice(hasAnyByok ? "byok" : "stella");
      } catch {
        // Best-effort; fall through to "stella" default.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [credentials.apiKeys, credentials.oauthCredentials]);

  // Persist the chosen engine pref + advance. Fire-and-forget so the
  // visible transition matches every other onboarding phase — the IPC
  // round-trip never holds the Continue click. If saving fails we still
  // advance and surface the error after the fact via the system event
  // listeners that already retry; blocking onboarding on a local-pref
  // write would be a worse UX than a one-line warning.
  const persistAndContinue = useCallback(
    (next: "default" | "claude_code_local") => {
      void (async () => {
        try {
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            agentRuntimeEngine: next,
          });
          window.dispatchEvent(
            new CustomEvent("stella:local-model-preferences-changed"),
          );
        } catch (caught) {
          // The user has already moved on by this point — log instead
          // of stranding them on the engine phase.
          console.warn(
            "[onboarding/engine] Failed to persist engine pref",
            caught,
          );
        }
      })();
      onContinue();
    },
    [onContinue],
  );

  const handleSelectStella = useCallback(() => {
    setChoice("stella");
    setActiveProvider(null);
  }, []);

  const handleSelectClaudeCode = useCallback(() => {
    setChoice("claude_code");
    setActiveProvider(null);
  }, []);

  const handleSelectByok = useCallback(() => {
    setChoice("byok");
    // BYOK runs through Stella's own runner — engine stays "default".
  }, []);

  const handleContinue = useCallback(() => {
    persistAndContinue(choice === "claude_code" ? "claude_code_local" : "default");
  }, [choice, persistAndContinue]);

  const handleProviderClick = useCallback((providerKey: string) => {
    // Toggle the inline auth panel for the picked provider so users can
    // collapse it with a second click instead of being forced to navigate
    // away. Resets transient draft state so each open starts clean.
    setActiveProvider((prev) => (prev === providerKey ? null : providerKey));
    setDraftKey("");
    setError(null);
  }, []);

  const handleLoginOAuth = useCallback(
    async (providerKey: string, label: string) => {
      setOauthInFlight(providerKey);
      setError(null);
      try {
        await credentials.loginOAuth(providerKey);
        setActiveProvider(null);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : `Sign-in to ${label} failed.`,
        );
      } finally {
        setOauthInFlight(null);
      }
    },
    [credentials],
  );

  const handleSaveKey = useCallback(
    async (providerKey: string, label: string) => {
      const trimmed = draftKey.trim();
      if (!trimmed) return;
      setSavingKey(true);
      setError(null);
      try {
        await credentials.saveApiKey(providerKey, label, trimmed);
        setDraftKey("");
        setActiveProvider(null);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : `Failed to save ${label} key.`,
        );
      } finally {
        setSavingKey(false);
      }
    },
    [credentials, draftKey],
  );

  const providerEntries = useMemo<ProviderEntry[]>(
    () =>
      BYOK_PROVIDER_KEYS.map((key) => {
        const entry = LLM_PROVIDERS.find((p) => p.key === key);
        if (!entry) return null;
        const apiKey = findApiKey(credentials.apiKeys, key);
        const oauthCredential = findOauthCredential(
          credentials.oauthCredentials,
          key,
        );
        const oauthProvider = findOauthProvider(
          credentials.oauthProviders,
          key,
        );
        const supportsOAuth = Boolean(oauthProvider);
        const supportsApiKey = !isApiKeyOnlyPlaceholder(entry.placeholder);
        const connected = Boolean(apiKey || oauthCredential);
        return { entry, connected, supportsOAuth, supportsApiKey };
      }).filter((item): item is ProviderEntry => item !== null),
    [
      credentials.apiKeys,
      credentials.oauthCredentials,
      credentials.oauthProviders,
    ],
  );

  const activeEntry = useMemo(
    () =>
      activeProvider
        ? providerEntries.find(({ entry }) => entry.key === activeProvider) ??
          null
        : null,
    [activeProvider, providerEntries],
  );

  return (
    <div className="onboarding-step-content onboarding-engine-step">
      <div className="onboarding-step-label">Engine</div>
      <p className="onboarding-step-desc">
        Choose what powers Stella. You can change this anytime in Settings.
      </p>

      <div className="onboarding-engine-tiles">
        <OnboardingSelectionTile
          className="onboarding-engine-tile"
          active={choice === "stella"}
          onClick={handleSelectStella}
          label="Stella"
          description="Default. Stella picks the right model for each task — no setup needed."
        />
        <OnboardingSelectionTile
          className="onboarding-engine-tile"
          active={choice === "claude_code"}
          onClick={handleSelectClaudeCode}
          label="Claude Code"
          description="Uses your Claude Code CLI with your account."
        />
        <OnboardingSelectionTile
          className="onboarding-engine-tile"
          active={choice === "byok"}
          onClick={handleSelectByok}
          label="Bring your own provider"
          description="Sign in or paste an API key for OpenAI, Anthropic, OpenRouter, and more."
        />
      </div>

      {choice === "byok" ? (
        <div className="onboarding-engine-byok">
          <div
            className="onboarding-engine-providers"
            role="list"
            aria-label="Available providers"
          >
            {providerEntries.map(
              ({ entry, connected, supportsOAuth, supportsApiKey }) => {
                const isActive = activeProvider === entry.key;
                const inFlight = oauthInFlight === entry.key;
                const Icon = connected
                  ? Check
                  : supportsOAuth
                    ? LogIn
                    : KeyRound;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="listitem"
                    className="onboarding-engine-provider"
                    data-active={isActive || undefined}
                    data-connected={connected || undefined}
                    data-pending={inFlight || undefined}
                    disabled={inFlight}
                    onClick={() => handleProviderClick(entry.key)}
                    title={
                      connected
                        ? `${entry.label} connected`
                        : supportsApiKey && supportsOAuth
                          ? `Sign in or add a ${entry.label} key`
                          : supportsOAuth
                            ? `Sign in to ${entry.label}`
                            : `Add a ${entry.label} key`
                    }
                  >
                    <Icon
                      size={12}
                      strokeWidth={1.75}
                      className="onboarding-engine-provider-icon"
                      aria-hidden
                    />
                    <span className="onboarding-engine-provider-label">
                      {entry.label}
                    </span>
                  </button>
                );
              },
            )}
          </div>

          {activeEntry ? (
            <div
              className="onboarding-engine-auth"
              role="region"
              aria-label={`Connect ${activeEntry.entry.label}`}
            >
              <div className="onboarding-engine-auth-head">
                <span className="onboarding-engine-auth-title">
                  Connect {activeEntry.entry.label}
                </span>
                <span className="onboarding-engine-auth-desc">
                  Credentials stay on this device.
                </span>
              </div>

              {activeEntry.supportsOAuth ? (
                <div className="onboarding-engine-auth-row">
                  <LogIn size={13} aria-hidden />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void handleLoginOAuth(
                        activeEntry.entry.key,
                        activeEntry.entry.label,
                      )
                    }
                    disabled={oauthInFlight === activeEntry.entry.key}
                  >
                    {oauthInFlight === activeEntry.entry.key
                      ? "Opening…"
                      : `Sign in with ${activeEntry.entry.label}`}
                  </Button>
                </div>
              ) : null}

              {activeEntry.supportsApiKey ? (
                <div className="onboarding-engine-auth-row">
                  <KeyRound size={13} aria-hidden />
                  <TextField
                    label={`${activeEntry.entry.label} API key`}
                    hideLabel
                    type="password"
                    placeholder={activeEntry.entry.placeholder}
                    value={draftKey}
                    onChange={(e) => setDraftKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleSaveKey(
                          activeEntry.entry.key,
                          activeEntry.entry.label,
                        );
                      }
                    }}
                    autoFocus={!activeEntry.supportsOAuth}
                    disabled={savingKey}
                  />
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() =>
                      void handleSaveKey(
                        activeEntry.entry.key,
                        activeEntry.entry.label,
                      )
                    }
                    disabled={!draftKey.trim() || savingKey}
                  >
                    {savingKey ? "Saving…" : "Save"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="onboarding-engine-error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={handleContinue}
      >
        Continue
      </button>
      {choice === "byok" ? (
        <button
          type="button"
          className="onboarding-engine-skip"
          disabled={splitTransitionActive}
          onClick={handleContinue}
        >
          I'll set this up later
        </button>
      ) : null}
    </div>
  );
}
