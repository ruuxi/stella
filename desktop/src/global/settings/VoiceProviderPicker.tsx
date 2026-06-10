/**
 * VoiceProviderPicker — the Voice tab of the model picker.
 *
 * One card per voice family (OpenAI / xAI / Inworld). Picking a card
 * selects that family; by default it runs through the user's Stella
 * account (no key needed). A key toggle on the card flips that family
 * to "bring your own key" — expanding an inline OAuth / API-key flow
 * the first time, then routing through the user's own account.
 *
 * The selected card grows to contain everything for that family: the
 * voice dropdown, the Inworld speed slider, and a "Read aloud" switch.
 * There is no separate provider list or sub-toggle below the cards —
 * the family is the card, and its settings live inside it.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LogIn,
} from "@/ui/icons";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { TextField } from "@/ui/text-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  findApiKey,
  findOauthCredential,
  findOauthProvider,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import {
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
} from "@/global/settings/lib/llm-providers";
import {
  readAloudPrefStore,
  setReadAloudEnabled,
} from "@/features/voice/services/read-aloud/read-aloud-pref";
import { stopReadAloud } from "@/features/voice/services/read-aloud/read-aloud-player";
import {
  DEFAULT_INWORLD_REALTIME_SPEED,
  getDefaultRealtimeVoice,
  getRealtimeVoiceCatalog,
} from "../../../../runtime/contracts/realtime-voice-catalog";
import {
  resolveRealtimeUnderlyingProvider,
  type RealtimeVoicePreferences,
  type RealtimeVoiceUnderlyingProvider,
} from "../../../../runtime/contracts/local-preferences";
import "./VoiceProviderPicker.css";

interface VoiceProviderPickerProps {
  /** Current realtime-voice preferences. */
  voice: RealtimeVoicePreferences;
  /** Merge a patch into the stored realtime-voice preferences. */
  onUpdateVoice: (patch: Partial<RealtimeVoicePreferences>) => void;
  disabled?: boolean;
}

const STELLA_PROVIDER_KEY = "stella";

type FamilyConfig = {
  family: RealtimeVoiceUnderlyingProvider;
  label: string;
  description: string;
  /** Credential provider key used for BYOK, or null when BYOK isn't available. */
  byokProvider: string | null;
};

const FAMILIES: readonly FamilyConfig[] = [
  {
    family: "openai",
    label: "OpenAI",
    description: "OpenAI Realtime voices.",
    byokProvider: "openai",
  },
  {
    family: "xai",
    label: "xAI",
    description: "Grok's Voice Agent.",
    byokProvider: "xai",
  },
  {
    family: "inworld",
    label: "Inworld",
    description: "Inworld TTS voices.",
    byokProvider: null,
  },
];

/** Families that expose a one-shot TTS endpoint usable for read-aloud. */
const READ_ALOUD_FAMILIES = new Set<RealtimeVoiceUnderlyingProvider>([
  "openai",
  "inworld",
]);

export function VoiceProviderPicker({
  voice,
  onUpdateVoice,
  disabled = false,
}: VoiceProviderPickerProps) {
  const credentials = useLlmCredentials();
  const readAloudEnabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );

  const [authFamily, setAuthFamily] =
    useState<RealtimeVoiceUnderlyingProvider | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const selectedFamily = resolveRealtimeUnderlyingProvider(voice);
  const usingOwnKey = voice.provider !== STELLA_PROVIDER_KEY;
  const activeReadAloudFamily = voice.readAloudProvider ?? "inworld";

  const isConnected = useCallback(
    (providerKey: string | null): boolean => {
      if (!providerKey) return false;
      if (findApiKey(credentials.apiKeys, providerKey)) return true;
      if (findOauthCredential(credentials.oauthCredentials, providerKey)) {
        return true;
      }
      return false;
    },
    [credentials.apiKeys, credentials.oauthCredentials],
  );

  const selectManaged = useCallback(
    (family: RealtimeVoiceUnderlyingProvider) => {
      setAuthFamily(null);
      setAuthError(null);
      onUpdateVoice({ provider: STELLA_PROVIDER_KEY, stellaSubProvider: family });
    },
    [onUpdateVoice],
  );

  const handleCardSelect = useCallback(
    (family: RealtimeVoiceUnderlyingProvider) => {
      if (disabled) return;
      // Re-selecting the active card keeps its current mode (managed or
      // BYOK); only an unselected card defaults back to managed.
      if (family === selectedFamily) return;
      selectManaged(family);
    },
    [disabled, selectManaged, selectedFamily],
  );

  const handleKeyToggle = useCallback(
    (config: FamilyConfig) => {
      if (disabled || !config.byokProvider) return;
      const { family, byokProvider } = config;
      const active = family === selectedFamily && usingOwnKey;
      if (active) {
        // Flip back to the Stella-managed account for this family.
        selectManaged(family);
        return;
      }
      if (isConnected(byokProvider)) {
        setAuthFamily(null);
        setAuthError(null);
        onUpdateVoice({ provider: family });
        return;
      }
      // Need credentials first — open the inline auth panel under the card.
      setAuthError(null);
      setDraftKey("");
      setAuthFamily((current) => (current === family ? null : family));
      if (family !== selectedFamily) {
        onUpdateVoice({
          provider: STELLA_PROVIDER_KEY,
          stellaSubProvider: family,
        });
      }
    },
    [disabled, isConnected, onUpdateVoice, selectManaged, selectedFamily, usingOwnKey],
  );

  const handleSaveKey = useCallback(
    async (config: FamilyConfig) => {
      if (!config.byokProvider) return;
      const trimmed = draftKey.trim();
      if (!trimmed) return;
      setSavingProvider(config.byokProvider);
      setAuthError(null);
      try {
        await credentials.saveApiKey(config.byokProvider, config.label, trimmed);
        setDraftKey("");
        setAuthFamily(null);
        onUpdateVoice({ provider: config.family });
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "Failed to save API key.",
        );
      } finally {
        setSavingProvider(null);
      }
    },
    [credentials, draftKey, onUpdateVoice],
  );

  const handleLoginOAuth = useCallback(
    async (config: FamilyConfig) => {
      if (!config.byokProvider) return;
      setOauthInFlight(config.byokProvider);
      setAuthError(null);
      try {
        await credentials.loginOAuth(config.byokProvider);
        setAuthFamily(null);
        onUpdateVoice({ provider: config.family });
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "OAuth login failed.",
        );
      } finally {
        setOauthInFlight(null);
      }
    },
    [credentials, onUpdateVoice],
  );

  const handleSelectVoice = useCallback(
    (family: RealtimeVoiceUnderlyingProvider, voiceId: string) => {
      if (disabled) return;
      onUpdateVoice({
        voices: { ...(voice.voices ?? {}), [family]: voiceId },
      });
    },
    [disabled, onUpdateVoice, voice.voices],
  );

  const handleSelectSpeed = useCallback(
    (speed: number) => {
      if (disabled) return;
      const clamped = Math.min(2.0, Math.max(0.5, speed));
      if (
        typeof voice.inworldSpeed === "number" &&
        Math.abs(voice.inworldSpeed - clamped) < 0.001
      ) {
        return;
      }
      onUpdateVoice({ inworldSpeed: clamped });
    },
    [disabled, onUpdateVoice, voice.inworldSpeed],
  );

  const handleToggleReadAloud = useCallback(
    (family: RealtimeVoiceUnderlyingProvider, checked: boolean) => {
      if (disabled) return;
      void setReadAloudEnabled(checked);
      if (!checked) {
        stopReadAloud();
        return;
      }
      if (family === "openai" || family === "inworld") {
        onUpdateVoice({ readAloudProvider: family });
      }
    },
    [disabled, onUpdateVoice],
  );

  return (
    <div
      className="voice-picker"
      role="radiogroup"
      aria-label="Voice provider"
      data-disabled={disabled || undefined}
    >
      {FAMILIES.map((config) => {
        const selected = config.family === selectedFamily;
        const byokActive = selected && usingOwnKey;
        const oauthProvider = config.byokProvider
          ? findOauthProvider(credentials.oauthProviders, config.byokProvider)
          : undefined;
        const llmEntry = config.byokProvider
          ? LLM_PROVIDERS.find((entry) => entry.key === config.byokProvider)
          : undefined;
        const supportsOAuth = Boolean(oauthProvider);
        const supportsApiKey =
          Boolean(llmEntry) &&
          !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");
        const authOpen =
          authFamily === config.family && !isConnected(config.byokProvider);

        return (
          <div
            key={config.family}
            className="voice-picker-card"
            data-selected={selected || undefined}
          >
            <div className="voice-picker-card-head">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className="voice-picker-card-main"
                onClick={() => handleCardSelect(config.family)}
                disabled={disabled}
              >
                <span className="voice-picker-card-text">
                  <span className="voice-picker-card-name">{config.label}</span>
                  <span className="voice-picker-card-desc">
                    {byokActive ? "Using your own key." : config.description}
                  </span>
                </span>
                {selected ? (
                  <Check size={14} className="voice-picker-card-check" />
                ) : null}
              </button>
              {config.byokProvider ? (
                <button
                  type="button"
                  className="voice-picker-card-key"
                  data-active={byokActive || undefined}
                  onClick={() => handleKeyToggle(config)}
                  disabled={disabled}
                  aria-pressed={byokActive}
                  title={
                    byokActive
                      ? "Using your own key — switch back to Stella"
                      : "Use your own key (BYOK)"
                  }
                  aria-label={
                    byokActive
                      ? `Use Stella's account for ${config.label}`
                      : `Use your own ${config.label} key`
                  }
                >
                  <KeyRound size={14} strokeWidth={1.85} />
                </button>
              ) : null}
            </div>

            {selected ? (
              <div className="voice-picker-card-body">
                {authOpen ? (
                  <div className="voice-picker-auth">
                    {supportsOAuth ? (
                      <div className="voice-picker-auth-line">
                        <LogIn size={13} aria-hidden />
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => void handleLoginOAuth(config)}
                          disabled={oauthInFlight !== null || disabled}
                        >
                          {oauthInFlight === config.byokProvider
                            ? "Opening…"
                            : `Sign in with ${config.label}`}
                        </Button>
                      </div>
                    ) : null}
                    {supportsApiKey ? (
                      <div className="voice-picker-auth-line">
                        <KeyRound size={13} aria-hidden />
                        <TextField
                          label={`${config.label} API key`}
                          hideLabel
                          type="password"
                          placeholder={llmEntry?.placeholder ?? "API key"}
                          value={draftKey}
                          onChange={(event) => setDraftKey(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void handleSaveKey(config);
                            }
                          }}
                          autoFocus={!supportsOAuth}
                          disabled={disabled}
                        />
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void handleSaveKey(config)}
                          disabled={
                            !draftKey.trim() ||
                            savingProvider === config.byokProvider ||
                            disabled
                          }
                        >
                          {savingProvider === config.byokProvider
                            ? "Saving…"
                            : "Save"}
                        </Button>
                      </div>
                    ) : null}
                    {authError ? (
                      <p className="voice-picker-auth-error" role="alert">
                        {authError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <VoiceStepper
                  family={config.family}
                  selectedVoices={voice.voices}
                  onSelectVoice={handleSelectVoice}
                  disabled={disabled}
                />

                {config.family === "inworld" ? (
                  <SpeedSlider
                    speed={voice.inworldSpeed ?? DEFAULT_INWORLD_REALTIME_SPEED}
                    onCommit={handleSelectSpeed}
                    disabled={disabled}
                  />
                ) : null}

                {READ_ALOUD_FAMILIES.has(config.family) ? (
                  <div className="voice-picker-readaloud">
                    <Switch
                      label="Read aloud replies"
                      checked={
                        readAloudEnabled &&
                        activeReadAloudFamily === config.family
                      }
                      onCheckedChange={(checked) =>
                        handleToggleReadAloud(config.family, checked)
                      }
                      disabled={disabled}
                    />
                    <p className="voice-picker-readaloud-desc">
                      Speaks finished replies in this voice.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ── Voice stepper ────────────────────────────────────────────── */

function VoiceStepper({
  family,
  selectedVoices,
  onSelectVoice,
  disabled,
}: {
  family: RealtimeVoiceUnderlyingProvider;
  selectedVoices: RealtimeVoicePreferences["voices"];
  onSelectVoice: (
    family: RealtimeVoiceUnderlyingProvider,
    voiceId: string,
  ) => void;
  disabled: boolean;
}) {
  const catalog = getRealtimeVoiceCatalog(family);
  const fallback = getDefaultRealtimeVoice(family);
  const activeVoiceId = selectedVoices?.[family]?.trim() || fallback;
  const activeIndex = useMemo(() => {
    const idx = catalog.findIndex((entry) => entry.id === activeVoiceId);
    return idx === -1 ? 0 : idx;
  }, [catalog, activeVoiceId]);
  const activeEntry = catalog[activeIndex] ?? catalog[0];

  const cycleBy = useCallback(
    (delta: number) => {
      if (disabled || catalog.length === 0) return;
      const next = (activeIndex + delta + catalog.length) % catalog.length;
      onSelectVoice(family, catalog[next]!.id);
    },
    [activeIndex, catalog, disabled, family, onSelectVoice],
  );

  return (
    <div className="voice-picker-stepper-wrap">
      <div className="voice-picker-stepper" role="group" aria-label="Voice">
        <button
          type="button"
          className="voice-picker-stepper-arrow"
          onClick={() => cycleBy(-1)}
          disabled={disabled || catalog.length < 2}
          aria-label="Previous voice"
        >
          <ChevronLeft size={14} strokeWidth={2} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="voice-picker-stepper-current"
              disabled={disabled}
            >
              <span className="voice-picker-stepper-name">
                {activeEntry?.label ?? "—"}
              </span>
              <ChevronDown size={12} strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="center"
            sideOffset={6}
            className="voice-picker-menu"
            aria-label="Voice"
          >
            {catalog.map((entry) => {
              const selected = entry.id === activeVoiceId;
              return (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => onSelectVoice(family, entry.id)}
                  disabled={disabled}
                  data-selected={selected || undefined}
                  className="voice-picker-menu-item"
                >
                  <span className="voice-picker-menu-item-text">
                    <span className="voice-picker-menu-item-name">
                      {entry.label}
                    </span>
                    <span className="voice-picker-menu-item-desc">
                      {entry.description}
                    </span>
                  </span>
                  {selected ? (
                    <Check size={13} className="voice-picker-menu-item-check" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className="voice-picker-stepper-arrow"
          onClick={() => cycleBy(1)}
          disabled={disabled || catalog.length < 2}
          aria-label="Next voice"
        >
          <ChevronRight size={14} strokeWidth={2} />
        </button>
      </div>
      {activeEntry?.description ? (
        <p className="voice-picker-stepper-desc">{activeEntry.description}</p>
      ) : null}
    </div>
  );
}

/* ── Speed slider (Inworld only) ──────────────────────────────── */

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const LOG_SPEED_MIN = Math.log(SPEED_MIN);
const LOG_SPEED_MAX = Math.log(SPEED_MAX);
const LOG_SPEED_RANGE = LOG_SPEED_MAX - LOG_SPEED_MIN;

const speedToSliderPosition = (speed: number): number => {
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
  return ((Math.log(clamped) - LOG_SPEED_MIN) / LOG_SPEED_RANGE) * 100;
};

const sliderPositionToSpeed = (position: number): number => {
  const clamped = Math.max(0, Math.min(100, position));
  const raw = Math.exp(LOG_SPEED_MIN + (clamped / 100) * LOG_SPEED_RANGE);
  return Math.round(raw * 20) / 20;
};

function SpeedSlider({
  speed,
  onCommit,
  disabled,
}: {
  speed: number;
  onCommit: (speed: number) => void;
  disabled: boolean;
}) {
  const [draftSpeed, setDraftSpeed] = useState(speed);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setDraftSpeed(speed);
  }, [speed]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      const position = Number.parseFloat(event.target.value);
      if (!Number.isFinite(position)) return;
      draggingRef.current = true;
      setDraftSpeed(sliderPositionToSpeed(position));
    },
    [disabled],
  );

  const handleCommit = useCallback(() => {
    if (disabled) return;
    draggingRef.current = false;
    if (Math.abs(draftSpeed - speed) < 0.001) return;
    onCommit(draftSpeed);
  }, [disabled, draftSpeed, onCommit, speed]);

  return (
    <div className="voice-picker-speed">
      <div className="voice-picker-speed-header">
        <span className="voice-picker-speed-label">Speed</span>
        <span className="voice-picker-speed-value">{draftSpeed.toFixed(2)}×</span>
      </div>
      <input
        type="range"
        className="voice-picker-speed-slider"
        min={0}
        max={100}
        step={0.5}
        value={speedToSliderPosition(draftSpeed)}
        onChange={handleChange}
        onPointerUp={handleCommit}
        onKeyUp={handleCommit}
        onBlur={handleCommit}
        disabled={disabled}
        aria-label="Inworld voice speed"
        aria-valuetext={`${draftSpeed.toFixed(2)}×`}
      />
      <div className="voice-picker-speed-marks">
        <span>0.5×</span>
        <span>1.0×</span>
        <span>2.0×</span>
      </div>
    </div>
  );
}
