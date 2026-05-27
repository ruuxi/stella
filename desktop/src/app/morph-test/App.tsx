import { useCallback, useEffect, useRef, useState } from "react";
import {
  MORPH_TEST_RELOAD_FEATURE_ENABLED,
  MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED,
} from "./metadata";
import {
  MORPH_TEST_HMR_FEATURE_ENABLED,
  MORPH_TEST_RELOAD_HMR_DETAIL_ENABLED,
  MORPH_TEST_RESTART_HMR_DETAIL_ENABLED,
} from "./scratch";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  type MorphTimingSettings,
  type MorphTimingTierSettings,
} from "@/shared/contracts/morph-timing";
import "./morph-test.css";

type Flavor = "ripple" | "glimm";
type Scenario = "hmr" | "reload" | "restart";

type LogEntry = {
  id: number;
  at: number;
  kind: "ok" | "err" | "info";
  text: string;
};

type CaptureBenchmarkResult = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI>["morphTest"]["measureCapture"]>
>;

const SCENARIOS: ReadonlyArray<{
  id: Scenario;
  label: string;
  actionLabel: string;
  description: string;
  hint: string;
}> = [
  {
    id: "hmr",
    label: "Trigger HMR",
    actionLabel: "Test HMR",
    description:
      "Toggles the HMR-only badge by touching only this app's renderer scratch file. No reload, no restart.",
    hint: "desktop/src/app/morph-test/scratch.ts",
  },
  {
    id: "reload",
    label: "Trigger full reload",
    actionLabel: "Test reload",
    description:
      "Toggles a reload feature while touching both renderer scratch and app metadata. Escalates to a covered full window reload.",
    hint: "scratch.ts + metadata.ts",
  },
  {
    id: "restart",
    label: "Trigger full Electron restart",
    actionLabel: "Test restart",
    description:
      "Toggles a restart feature while touching renderer, metadata, and Electron main-process scratch files. Escalates to Electron relaunch.",
    hint: "scratch.ts + metadata.ts + desktop/electron scratch",
  },
];

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour12: false });

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const TIMING_STORAGE_KEY = "stella:morph-test:timing";

type TimingFieldKey = keyof MorphTimingTierSettings;

const TIMING_FIELD_SLIDERS: ReadonlyArray<{
  key: TimingFieldKey;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  {
    key: "settleDelayMs",
    label: "Capture wait",
    min: 0,
    max: 10_000,
    step: 50,
  },
  {
    key: "coverRampMs",
    label: "Cover ramp",
    min: 0,
    max: 3_000,
    step: 10,
  },
  {
    key: "handoffFadeMs",
    label: "Handoff fade",
    min: 0,
    max: 3_000,
    step: 10,
  },
  {
    key: "glimmCoverSweepMs",
    label: "Glimm cover sweep",
    min: 0,
    max: 2_000,
    step: 10,
  },
  {
    key: "glimmRevealSweepMs",
    label: "Glimm reveal sweep",
    min: 0,
    max: 2_000,
    step: 10,
  },
  {
    key: "glimmOutroFadeMs",
    label: "Glimm fade out",
    min: 0,
    max: 2_000,
    step: 10,
  },
];

const cloneTiming = (timing: MorphTimingSettings): MorphTimingSettings => ({
  hmr: { ...timing.hmr },
  reload: { ...timing.reload },
});

const readSavedTiming = (): MorphTimingSettings | null => {
  try {
    const raw = window.localStorage.getItem(TIMING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MorphTimingSettings) : null;
  } catch {
    return null;
  }
};

const saveTiming = (timing: MorphTimingSettings | null) => {
  try {
    if (timing) {
      window.localStorage.setItem(TIMING_STORAGE_KEY, JSON.stringify(timing));
    } else {
      window.localStorage.removeItem(TIMING_STORAGE_KEY);
    }
  } catch {
    // Best-effort only; the Electron main-process override is still applied.
  }
};

export function MorphTestApp() {
  const api = window.electronAPI?.morphTest ?? null;
  const apiMissing = api == null;

  const [flavor, setFlavor] = useState<Flavor>("ripple");
  const [pending, setPending] = useState<Scenario | null>(null);
  const [capturePending, setCapturePending] = useState(false);
  const [captureBenchmark, setCaptureBenchmark] =
    useState<CaptureBenchmarkResult | null>(null);
  const [timing, setTiming] = useState<MorphTimingSettings>(() =>
    cloneTiming(DEFAULT_MORPH_TIMING_SETTINGS),
  );
  const timingRef = useRef(timing);
  const timingDraggingRef = useRef(false);
  const [logs, setLogs] = useState<ReadonlyArray<LogEntry>>([]);
  const nextLogId = useRef(1);

  useEffect(() => {
    timingRef.current = timing;
  }, [timing]);

  const appendLog = useCallback(
    (kind: LogEntry["kind"], text: string) => {
      setLogs((prev) => {
        const next: LogEntry = {
          id: nextLogId.current++,
          at: Date.now(),
          kind,
          text,
        };
        const trimmed = prev.length >= 25 ? prev.slice(prev.length - 24) : prev;
        return [...trimmed, next];
      });
    },
    [],
  );

  // Push the initial flavor preference once on mount so the overlay's
  // HMR override matches the toggle's visual state before the user clicks
  // anything (defaults to ripple).
  useEffect(() => {
    if (!api) return;
    void api
      .setPreferredFlavor("ripple")
      .then(() => {
        appendLog("info", "Default morph flavor: ripple");
      })
      .catch((error: unknown) => {
        appendLog(
          "err",
          `Failed to seed default flavor: ${(error as Error).message ?? String(error)}`,
        );
      });
  }, [api, appendLog]);

  useEffect(() => {
    if (!api) return;
    const savedTiming = readSavedTiming();
    const loadTiming = savedTiming
      ? api.setTimingSettings(savedTiming)
      : api.getTimingSettings();
    void loadTiming
      .then((result) => {
        setTiming(cloneTiming(result.timing));
        if (savedTiming) saveTiming(result.timing);
      })
      .catch((error: unknown) => {
        appendLog(
          "err",
          `Failed to load timing settings: ${(error as Error).message ?? String(error)}`,
        );
      });
  }, [api, appendLog]);

  const handleFlavor = useCallback(
    async (next: Flavor) => {
      if (!api) return;
      setFlavor(next);
      try {
        await api.setPreferredFlavor(next);
        appendLog("info", `Morph flavor set to ${next}`);
      } catch (error) {
        appendLog(
          "err",
          `Failed to set flavor: ${(error as Error).message ?? String(error)}`,
        );
      }
    },
    [api, appendLog],
  );

  const handleScenario = useCallback(
    async (scenario: Scenario) => {
      if (!api) return;
      setPending(scenario);
      try {
        const result = await api.triggerSelfMod(scenario);
        appendLog(
          "ok",
          `${scenario}: edited ${result.filePath} (runId ${result.runId.slice(0, 22)}…)`,
        );
      } catch (error) {
        appendLog(
          "err",
          `${scenario}: ${(error as Error).message ?? String(error)}`,
        );
      } finally {
        setPending(null);
      }
    },
    [api, appendLog],
  );

  const handleMeasureCapture = useCallback(async () => {
    if (!api) return;
    setCapturePending(true);
    try {
      const result = await api.measureCapture(10);
      setCaptureBenchmark(result);
      appendLog(
        result.ok ? "ok" : "err",
        `capture: capturePage avg ${result.summary.capturePageAvgMs} ms, data URL avg ${result.summary.totalDataUrlAvgMs} ms`,
      );
    } catch (error) {
      appendLog(
        "err",
        `capture benchmark failed: ${(error as Error).message ?? String(error)}`,
      );
    } finally {
      setCapturePending(false);
    }
  }, [api, appendLog]);

  const clampTimingValue = (
    value: number,
    min: number,
    max: number,
    step: number,
  ): number => {
    const stepped = Math.round(value / step) * step;
    return Math.min(max, Math.max(min, stepped));
  };

  const commitTimingSettings = useCallback(async () => {
    if (!api || !timingDraggingRef.current) return;
    timingDraggingRef.current = false;
    const snapshot = cloneTiming(timingRef.current);
    try {
      const result = await api.setTimingSettings(snapshot);
      setTiming(cloneTiming(result.timing));
      saveTiming(result.timing);
    } catch (error) {
      appendLog(
        "err",
        `Failed to set timing: ${(error as Error).message ?? String(error)}`,
      );
    }
  }, [api, appendLog]);

  const handleTimingSliderChange = useCallback(
    (
      tier: keyof MorphTimingSettings,
      key: TimingFieldKey,
      rawValue: number,
    ) => {
      const config = TIMING_FIELD_SLIDERS.find((field) => field.key === key);
      if (!config) return;
      timingDraggingRef.current = true;
      const value = clampTimingValue(
        rawValue,
        config.min,
        config.max,
        config.step,
      );
      setTiming((prev) => {
        const next = cloneTiming(prev);
        next[tier][key] = value;
        timingRef.current = next;
        return next;
      });
    },
    [],
  );

  const resetTiming = useCallback(async () => {
    if (!api) return;
    timingDraggingRef.current = false;
    try {
      const result = await api.resetTimingSettings();
      setTiming(cloneTiming(result.timing));
      saveTiming(null);
      appendLog("info", "Timing settings reset to defaults");
    } catch (error) {
      appendLog(
        "err",
        `Failed to reset timing: ${(error as Error).message ?? String(error)}`,
      );
    }
  }, [api, appendLog]);

  return (
    <main className="morph-test">
      <header className="morph-test__hero">
        <h1 className="morph-test__title">
          <em>Morph</em> test
        </h1>
        <p className="morph-test__lede">
          Drive real self-mod runs from a button: each trigger toggles a visible
          feature, lets the runtime's morph cover wrap the change when
          applicable, and walks the real HMR, reload, or restart pipeline.
        </p>
      </header>

      <section className="morph-test__feature-stage" aria-label="Feature state">
        <article
          className={`morph-test__feature-card ${
            MORPH_TEST_HMR_FEATURE_ENABLED ? "is-active" : ""
          }`}
        >
          <span className="morph-test__feature-kicker">HMR only</span>
          <strong>Signal badge</strong>
          <span>
            {MORPH_TEST_HMR_FEATURE_ENABLED
              ? "Live through renderer HMR"
              : "Off until HMR toggles it"}
          </span>
        </article>
        <article
          className={`morph-test__feature-card morph-test__feature-card--reload ${
            MORPH_TEST_RELOAD_FEATURE_ENABLED ? "is-active" : ""
          }`}
        >
          <span className="morph-test__feature-kicker">Reload tier</span>
          <strong>Glass panel</strong>
          <span>
            {MORPH_TEST_RELOAD_FEATURE_ENABLED
              ? "Reload feature mounted"
              : "Hidden until reload toggles it"}
          </span>
          {MORPH_TEST_RELOAD_HMR_DETAIL_ENABLED ? (
            <small>Renderer detail also changed.</small>
          ) : null}
        </article>
        <article
          className={`morph-test__feature-card morph-test__feature-card--restart ${
            MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED ? "is-active" : ""
          }`}
        >
          <span className="morph-test__feature-kicker">Restart tier</span>
          <strong>Shell ribbon</strong>
          <span>
            {MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED
              ? "Electron restart feature mounted"
              : "Hidden until restart toggles it"}
          </span>
          {MORPH_TEST_RESTART_HMR_DETAIL_ENABLED ? (
            <small>Renderer + reload files changed too.</small>
          ) : null}
        </article>
      </section>

      <section className="morph-test__section" aria-labelledby="flavor-h">
        <h2 id="flavor-h" className="morph-test__section-title">
          Morph flavor
        </h2>
        <p className="morph-test__section-body">
          Choose which transition the overlay paints for the next self-mod
          run. Applies to every trigger below until you switch it back.
        </p>
        <div className="morph-test__flavor-row" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={flavor === "ripple"}
            className={`pill-btn pill-btn--lg ${
              flavor === "ripple" ? "pill-btn--primary" : ""
            }`}
            disabled={apiMissing}
            onClick={() => void handleFlavor("ripple")}
          >
            Ripple (default)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={flavor === "glimm"}
            className={`pill-btn pill-btn--lg ${
              flavor === "glimm" ? "pill-btn--primary" : ""
            }`}
            disabled={apiMissing}
            onClick={() => void handleFlavor("glimm")}
          >
            Glimm sweep
          </button>
        </div>
      </section>

      <section className="morph-test__section" aria-labelledby="scenarios-h">
        <h2 id="scenarios-h" className="morph-test__section-title">
          Trigger a self-mod run
        </h2>
        <ul className="morph-test__scenario-list">
          {SCENARIOS.map((scenario) => {
            const busy = pending === scenario.id;
            return (
              <li key={scenario.id} className="morph-test__scenario">
                <div className="morph-test__scenario-text">
                  <span className="morph-test__scenario-label">
                    {scenario.label}
                  </span>
                  <span className="morph-test__scenario-description">
                    {scenario.description}
                  </span>
                  <code className="morph-test__scenario-hint">
                    {scenario.hint}
                  </code>
                </div>
                <button
                  type="button"
                  className="pill-btn pill-btn--lg pill-btn--primary"
                  disabled={apiMissing || pending !== null}
                  onClick={() => void handleScenario(scenario.id)}
                >
                  {busy ? "Triggering..." : scenario.actionLabel}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="morph-test__section" aria-labelledby="capture-h">
        <div className="morph-test__section-heading-row">
          <h2 id="capture-h" className="morph-test__section-title">
            Capture benchmark
          </h2>
          <button
            type="button"
            className="pill-btn"
            disabled={apiMissing || capturePending}
            onClick={() => void handleMeasureCapture()}
          >
            {capturePending ? "Measuring..." : "Measure capture"}
          </button>
        </div>
        <p className="morph-test__section-body">
          Runs the same full-window capture helper used by morph and measures
          both raw capture readiness and full JPEG data URL readiness.
        </p>
        {captureBenchmark ? (
          <div className="morph-test__capture-card">
            <div className="morph-test__capture-stat">
              <span>Capture ready</span>
              <strong>{captureBenchmark.summary.capturePageAvgMs} ms avg</strong>
              <small>
                {captureBenchmark.summary.capturePageMinMs}-
                {captureBenchmark.summary.capturePageMaxMs} ms
              </small>
            </div>
            <div className="morph-test__capture-stat">
              <span>Data URL ready</span>
              <strong>{captureBenchmark.summary.totalDataUrlAvgMs} ms avg</strong>
              <small>
                {captureBenchmark.summary.totalDataUrlMinMs}-
                {captureBenchmark.summary.totalDataUrlMaxMs} ms
              </small>
            </div>
            <div className="morph-test__capture-stat">
              <span>Average payload</span>
              <strong>
                {formatBytes(captureBenchmark.summary.avgDataUrlBytes)}
              </strong>
              <small>{captureBenchmark.summary.count} samples</small>
            </div>
          </div>
        ) : null}
      </section>

      <section className="morph-test__section" aria-labelledby="timing-h">
        <div className="morph-test__section-heading-row">
          <h2 id="timing-h" className="morph-test__section-title">
            Timing overrides
          </h2>
          <button
            type="button"
            className="pill-btn"
            disabled={apiMissing}
            onClick={() => void resetTiming()}
          >
            Reset
          </button>
        </div>
        <p className="morph-test__section-body">
          Tune the old capture's cover, the wait before taking the new capture,
          and the handoff once that second capture is ready.
        </p>
        <div className="morph-test__timing-grid">
          {(["hmr", "reload"] as const).map((tier) => (
            <div key={tier} className="morph-test__timing-card">
              <span className="morph-test__timing-tier">
                {tier === "hmr" ? "HMR" : "Reload"}
              </span>
              {TIMING_FIELD_SLIDERS.map((field) => (
                <div key={field.key} className="morph-test__timing-field">
                  <div className="morph-test__timing-field-head">
                    <span>{field.label}</span>
                    <span className="morph-test__timing-field-value">
                      {timing[tier][field.key]} ms
                    </span>
                  </div>
                  <input
                    type="range"
                    className="morph-test__timing-slider"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={timing[tier][field.key]}
                    disabled={apiMissing}
                    aria-valuetext={`${timing[tier][field.key]} milliseconds`}
                    onChange={(event) =>
                      handleTimingSliderChange(
                        tier,
                        field.key,
                        Number(event.currentTarget.value),
                      )
                    }
                    onPointerUp={() => void commitTimingSettings()}
                    onKeyUp={() => void commitTimingSettings()}
                    onBlur={() => void commitTimingSettings()}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="morph-test__section" aria-labelledby="log-h">
        <h2 id="log-h" className="morph-test__section-title">
          Activity
        </h2>
        {apiMissing ? (
          <p className="morph-test__empty">
            The morph-test bridge is unavailable. This page only works inside
            the Electron desktop app.
          </p>
        ) : logs.length === 0 ? (
          <p className="morph-test__empty">
            No actions yet. Pick a flavor, then run a scenario above.
          </p>
        ) : (
          <ul className="morph-test__log">
            {logs.map((entry) => (
              <li
                key={entry.id}
                className={`morph-test__log-row morph-test__log-row--${entry.kind}`}
              >
                <time className="morph-test__log-time">
                  {formatTime(entry.at)}
                </time>
                <span className="morph-test__log-text">{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
