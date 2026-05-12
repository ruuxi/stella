/**
 * VoiceCatalogPicker — voice selector that appears below the provider
 * list on the Voice tab of the model picker.
 *
 * Layout, top to bottom:
 *   - Label row. In Stella mode the right-hand area shows the OpenAI /
 *     xAI / Inworld sub-toggle; in BYOK modes it shows a static source
 *     label ("OpenAI voices" / "Grok voices" / "Inworld voices").
 *   - Voice stepper: a single horizontal box with left/right chevrons
 *     on either side of the current voice label. Chevrons cycle through
 *     the active catalog; clicking the label opens a dropdown listing
 *     every voice with its tone description.
 *   - Inworld-only speed slider. Only renders when the active
 *     underlying provider is `inworld`. Persists to
 *     `realtimeVoice.inworldSpeed` so the user's chosen speed survives
 *     provider switches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
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
import "./VoiceCatalogPicker.css";

interface VoiceCatalogPickerProps {
  /** Voice provider selected by the user (stella/openai/xai/inworld). */
  voiceProvider: RealtimeVoicePreferences["provider"];
  /** Active sub-family when in Stella mode. Defaults to "openai". */
  stellaSubProvider: RealtimeVoiceUnderlyingProvider | undefined;
  /** Currently stored voice ids, keyed by underlying provider. */
  selectedVoices: RealtimeVoicePreferences["voices"];
  /** Stored Inworld TTS speed (1.0 = real-time). */
  inworldSpeed: number | undefined;
  /**
   * Called when the user picks a voice. Receives the underlying provider
   * key so the caller can store the choice under the right key without
   * ambiguity.
   */
  onSelectVoice: (
    underlyingProvider: RealtimeVoiceUnderlyingProvider,
    voiceId: string,
  ) => void;
  /**
   * Called when the user switches Stella's sub-family. Only fires in
   * Stella mode (BYOK modes are pinned).
   */
  onSelectStellaSubProvider: (
    subProvider: RealtimeVoiceUnderlyingProvider,
  ) => void;
  /** Called when the user moves the Inworld speed slider. */
  onSelectInworldSpeed: (speed: number) => void;
  disabled?: boolean;
}

/**
 * Speed slider uses a logarithmic mapping so that 1.0× lands at the
 * geometric centre of the slider. With a linear 0.5–2.0 range the
 * midpoint would be 1.25× — users naturally drag toward the middle
 * expecting "normal" and end up at 1.25, which sounds noticeably fast.
 *
 * Slider's internal value is 0–100 (a position). The displayed/stored
 * speed is computed via exp(log-interpolated), then snapped to 0.05
 * for clean numbers.
 */
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
  // Snap to 0.05 so the displayed value stays clean.
  return Math.round(raw * 20) / 20;
};

export function VoiceCatalogPicker({
  voiceProvider,
  stellaSubProvider,
  selectedVoices,
  inworldSpeed,
  onSelectVoice,
  onSelectStellaSubProvider,
  onSelectInworldSpeed,
  disabled = false,
}: VoiceCatalogPickerProps) {
  // For BYOK modes this is pinned to the provider; for Stella mode it
  // follows the user's sub-family choice (default "openai").
  const underlyingProvider = resolveRealtimeUnderlyingProvider({
    provider: voiceProvider,
    stellaSubProvider,
  });

  const catalog = getRealtimeVoiceCatalog(underlyingProvider);
  const fallback = getDefaultRealtimeVoice(underlyingProvider);
  const activeVoiceId =
    selectedVoices?.[underlyingProvider]?.trim() || fallback;
  const activeIndex = useMemo(() => {
    const idx = catalog.findIndex((entry) => entry.id === activeVoiceId);
    return idx === -1 ? 0 : idx;
  }, [catalog, activeVoiceId]);
  const activeEntry = catalog[activeIndex] ?? catalog[0];

  const showSubToggle = voiceProvider === "stella";
  const showSpeed = underlyingProvider === "inworld";
  const activeSpeed = inworldSpeed ?? DEFAULT_INWORLD_REALTIME_SPEED;

  // ── Speed slider: commit on release ──────────────────────────────
  // The slider stays responsive during drag (local state drives the
  // displayed value) but only writes to prefs on pointer-up / keyboard
  // arrow release. Otherwise every slider tick fires an IPC write and
  // the prop comes back, re-rendering the parent on each pixel of drag.
  const [draftSpeed, setDraftSpeed] = useState(activeSpeed);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) {
      setDraftSpeed(activeSpeed);
    }
  }, [activeSpeed]);

  const commitSpeed = useCallback(
    (value: number) => {
      draggingRef.current = false;
      if (Math.abs(value - activeSpeed) < 0.001) return;
      onSelectInworldSpeed(value);
    },
    [activeSpeed, onSelectInworldSpeed],
  );

  // ── Stepper dropdown ────────────────────────────────────────────
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dropdownOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current && !dropdownRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [dropdownOpen]);

  const cycleBy = useCallback(
    (delta: number) => {
      if (disabled || catalog.length === 0) return;
      const next = (activeIndex + delta + catalog.length) % catalog.length;
      onSelectVoice(underlyingProvider, catalog[next]!.id);
    },
    [activeIndex, catalog, disabled, onSelectVoice, underlyingProvider],
  );

  const handleDropdownPick = useCallback(
    (voiceId: string) => {
      if (disabled) return;
      onSelectVoice(underlyingProvider, voiceId);
      setDropdownOpen(false);
    },
    [disabled, onSelectVoice, underlyingProvider],
  );

  const handleSubToggle = useCallback(
    (sub: RealtimeVoiceUnderlyingProvider) => {
      if (disabled || !showSubToggle) return;
      onSelectStellaSubProvider(sub);
    },
    [disabled, onSelectStellaSubProvider, showSubToggle],
  );

  const handleSpeedChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      const position = Number.parseFloat(event.target.value);
      if (!Number.isFinite(position)) return;
      draggingRef.current = true;
      setDraftSpeed(sliderPositionToSpeed(position));
    },
    [disabled],
  );

  const handleSpeedCommit = useCallback(() => {
    if (disabled) return;
    commitSpeed(draftSpeed);
  }, [commitSpeed, disabled, draftSpeed]);

  const labelSourceText =
    underlyingProvider === "xai"
      ? "Grok voices"
      : underlyingProvider === "inworld"
        ? "Inworld voices"
        : "OpenAI voices";

  return (
    <div
      className="voice-catalog-picker"
      data-disabled={disabled || undefined}
    >
      <div className="voice-catalog-picker-label">
        <span>Voice</span>
        {showSubToggle ? (
          <div
            className="voice-catalog-subtoggle"
            role="tablist"
            aria-label="Voice family"
          >
            <button
              type="button"
              role="tab"
              aria-selected={underlyingProvider === "openai"}
              className="voice-catalog-subtoggle-btn"
              data-active={underlyingProvider === "openai" || undefined}
              onClick={() => handleSubToggle("openai")}
              disabled={disabled}
              title="OpenAI Realtime voices (Stella mints the token)"
            >
              OpenAI
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={underlyingProvider === "xai"}
              className="voice-catalog-subtoggle-btn"
              data-active={underlyingProvider === "xai" || undefined}
              onClick={() => handleSubToggle("xai")}
              disabled={disabled}
              title="xAI Grok voices (Stella mints the token)"
            >
              xAI
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={underlyingProvider === "inworld"}
              className="voice-catalog-subtoggle-btn"
              data-active={underlyingProvider === "inworld" || undefined}
              onClick={() => handleSubToggle("inworld")}
              disabled={disabled}
              title="Inworld voices (Stella proxies the SDP exchange)"
            >
              Inworld
            </button>
          </div>
        ) : (
          <span className="voice-catalog-picker-label-source">
            {labelSourceText}
          </span>
        )}
      </div>

      <div className="voice-catalog-stepper-wrap" ref={dropdownRef}>
        <div
          className="voice-catalog-stepper"
          role="group"
          aria-label="Voice"
        >
          <button
            type="button"
            className="voice-catalog-stepper-arrow"
            onClick={() => cycleBy(-1)}
            disabled={disabled || catalog.length < 2}
            aria-label="Previous voice"
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="voice-catalog-stepper-current"
            onClick={() => setDropdownOpen((prev) => !prev)}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
          >
            <span className="voice-catalog-stepper-name">
              {activeEntry?.label ?? "—"}
            </span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              data-rotated={dropdownOpen || undefined}
            />
          </button>
          <button
            type="button"
            className="voice-catalog-stepper-arrow"
            onClick={() => cycleBy(1)}
            disabled={disabled || catalog.length < 2}
            aria-label="Next voice"
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
        {activeEntry?.description ? (
          <p className="voice-catalog-stepper-desc">{activeEntry.description}</p>
        ) : null}
        {dropdownOpen ? (
          <div
            className="voice-catalog-dropdown"
            role="listbox"
            aria-label={`${labelSourceText} voice`}
          >
            {catalog.map((voice) => {
              const selected = voice.id === activeVoiceId;
              return (
                <button
                  key={voice.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="voice-catalog-dropdown-row"
                  data-selected={selected || undefined}
                  onClick={() => handleDropdownPick(voice.id)}
                  disabled={disabled}
                >
                  <span className="voice-catalog-dropdown-row-text">
                    <span className="voice-catalog-dropdown-row-name">
                      {voice.label}
                    </span>
                    <span className="voice-catalog-dropdown-row-desc">
                      {voice.description}
                    </span>
                  </span>
                  {selected ? (
                    <Check size={13} className="voice-catalog-dropdown-row-check" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {showSpeed ? (
        <div className="voice-catalog-speed">
          <div className="voice-catalog-speed-header">
            <span className="voice-catalog-speed-label">Speed</span>
            <span className="voice-catalog-speed-value">
              {draftSpeed.toFixed(2)}×
            </span>
          </div>
          <input
            type="range"
            className="voice-catalog-speed-slider"
            min={0}
            max={100}
            step={0.5}
            value={speedToSliderPosition(draftSpeed)}
            onChange={handleSpeedChange}
            onPointerUp={handleSpeedCommit}
            onKeyUp={handleSpeedCommit}
            onBlur={handleSpeedCommit}
            disabled={disabled}
            aria-label="Inworld voice speed"
            aria-valuetext={`${draftSpeed.toFixed(2)}×`}
          />
          <div className="voice-catalog-speed-marks">
            <span>0.5×</span>
            <span>1.0×</span>
            <span>2.0×</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
