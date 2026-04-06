import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { InstallerState, SetupStep } from "./types";
import stellaLogo from "./stella-logo.svg";

const formatBytes = (bytes: number | null): string => {
  if (bytes == null) return "unknown";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/* ── App ─────────────────────────────────────────────────────────── */

function App() {
  const [state, setState] = useState<InstallerState | null>(null);
  const [installPathDraft, setInstallPathDraft] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const pendingAutoClose = useRef(false);

  const applyState = useCallback((nextState: InstallerState) => {
    startTransition(() => setState(nextState));
  }, []);

  useEffect(() => {
    if (state) setInstallPathDraft(state.installPath);
  }, [state?.installPath]);

  useEffect(() => {
    const unlisten = listen<{ state: InstallerState }>(
      "installer-state-update",
      (event) => applyState(event.payload.state),
    );
    invoke<InstallerState>("get_installer_state").then(applyState);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyState]);

  // Poll desktop running state
  useEffect(() => {
    if (!state || state.phase !== "complete") return;
    const poll = () => {
      invoke<boolean>("is_desktop_running")
        .then(setDesktopRunning)
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [state?.phase]);

  // Auto-close launcher when desktop is confirmed running after install
  useEffect(() => {
    if (desktopRunning && pendingAutoClose.current) {
      pendingAutoClose.current = false;
      getCurrentWindow().close();
    }
  }, [desktopRunning]);

  const commitInstallPath = useCallback(async () => {
    if (!state) return;
    const nextPath = installPathDraft.trim();
    if (!nextPath || nextPath === state.installPath) return;
    setLocationBusy(true);
    try {
      applyState(
        await invoke<InstallerState>("set_install_location", {
          path: nextPath,
        }),
      );
    } finally {
      setLocationBusy(false);
    }
  }, [applyState, installPathDraft, state]);

  const handleBrowse = useCallback(async () => {
    setLocationBusy(true);
    try {
      applyState(await invoke<InstallerState>("browse_install_location"));
    } finally {
      setLocationBusy(false);
    }
  }, [applyState]);

  const handleUseDefaultLocation = useCallback(async () => {
    if (!state) return;
    setInstallPathDraft(state.defaultInstallPath);
    setLocationBusy(true);
    try {
      applyState(
        await invoke<InstallerState>("set_install_location", {
          path: state.defaultInstallPath,
        }),
      );
    } finally {
      setLocationBusy(false);
    }
  }, [applyState, state]);

  const handleInstall = useCallback(async () => {
    await commitInstallPath();
    pendingAutoClose.current = true;
    await invoke("start_install");
  }, [commitInstallPath]);

  const handleLaunch = useCallback(async () => {
    const result = await invoke<{ ok: boolean }>("launch_desktop");
    if (result.ok) {
      getCurrentWindow().close();
    }
  }, []);

  const handleOpenFolder = useCallback(async () => {
    await invoke("open_install_location");
  }, []);

  const handleUninstall = useCallback(async () => {
    if (!window.confirm("This will remove Stella and its data. Continue?"))
      return;
    await invoke("uninstall_stella");
  }, []);

  /* ── Derived ─────────────────────────────────────────────────── */

  const { progress, activeStep } = useMemo(() => {
    if (!state) return { progress: 0, activeStep: null as null | SetupStep };
    const steps = state.steps;
    const total = steps.length;
    if (total === 0) return { progress: 0, activeStep: null };

    let completed = 0;
    let active: (typeof steps)[0] | null = null;
    for (const s of steps) {
      if (s.status === "done" || s.status === "skipped") {
        completed++;
      } else if (
        !active &&
        (s.status === "installing" || s.status === "checking")
      ) {
        active = s;
      }
    }

    const base = (completed / total) * 100;
    const stepWeight = 100 / total;
    const inProgress = active ? stepWeight * 0.5 : 0;

    return {
      progress: Math.min(Math.round(base + inProgress), 99),
      activeStep: active,
    };
  }, [state]);

  /* ── Loading / splash ────────────────────────────────────────── */

  if (!state) {
    return (
      <div className="shell">
        <div className="drag-region" />
        <div className="brand">
          <img src={stellaLogo} alt="Stella" className="brand-logo" />
          <h1 className="brand-name">Stella</h1>
        </div>
        <div
          className="body"
          style={{ alignItems: "center", justifyContent: "center" }}
        >
          <p className="status-text">Loading...</p>
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill indeterminate" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isSetup = state.phase === "ready" || state.phase === "error";
  const isWorking = state.phase === "installing" || state.phase === "checking";
  const isComplete = state.phase === "complete";

  const canInstall =
    isSetup &&
    !state.installPathError &&
    state.disk.enoughSpace &&
    !locationBusy;

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="shell">
      <div className="drag-region" />

      {/* Brand header — always visible */}
      <div className="brand">
        <img src={stellaLogo} alt="Stella" className="brand-logo" />
        <h1 className="brand-name">Stella</h1>
      </div>

      {/* Body */}
      <main className="body">
        {/* ── Ready / Error ───────────────────────────────── */}
        {isSetup && (
          <>
            <p className="status-text">Choose where to install Stella</p>

            <div className="field-group">
              <label className="field-label">Location</label>
              <div className="path-row">
                <input
                  className="path-input"
                  value={installPathDraft}
                  onChange={(e) => setInstallPathDraft(e.target.value)}
                  onBlur={() => void commitInstallPath()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitInstallPath();
                    }
                  }}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleBrowse()}
                  disabled={locationBusy}
                >
                  Browse
                </button>
              </div>

              <div className="field-meta">
                {state.installPathError ? (
                  <span className="field-error">{state.installPathError}</span>
                ) : (
                  <span className="field-hint">
                    {formatBytes(state.disk.requiredBytes)} needed
                    {" \u00b7 "}
                    {formatBytes(state.disk.availableBytes)} available
                  </span>
                )}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => void handleUseDefaultLocation()}
                  disabled={locationBusy}
                >
                  Reset
                </button>
              </div>
            </div>

            {!state.disk.enoughSpace && (
              <div className="banner banner-warn">
                Not enough disk space at this location.
              </div>
            )}

            {state.errorMessage && !state.installPathError && (
              <div className="banner banner-error">{state.errorMessage}</div>
            )}
          </>
        )}

        {/* ── Installing / Checking ───────────────────────── */}
        {isWorking && (
          <div className="install-progress">
            <div className="progress-wrap">
              <div className="progress-track">
                <div
                  className={`progress-fill ${state.phase === "checking" ? "indeterminate" : ""}`}
                  style={
                    state.phase !== "checking"
                      ? { width: `${progress}%` }
                      : undefined
                  }
                />
              </div>
            </div>

            <ul className="step-list">
              {state.steps.map((step) => (
                <li key={step.id} className={`step-item ${step.status}`}>
                  <span className="step-icon">
                    {step.status === "done" ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <circle
                          cx="7"
                          cy="7"
                          r="6.5"
                          stroke="var(--green)"
                          strokeWidth="1"
                        />
                        <path
                          d="M4 7.2L6 9.2L10 5"
                          stroke="var(--green)"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : step.status === "skipped" ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <circle
                          cx="7"
                          cy="7"
                          r="6.5"
                          stroke="var(--text-faint)"
                          strokeWidth="1"
                        />
                        <path
                          d="M4.5 7H9.5"
                          stroke="var(--text-faint)"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : step.status === "installing" ||
                      step.status === "checking" ? (
                      <span className="step-spinner" />
                    ) : step.status === "error" ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <circle
                          cx="7"
                          cy="7"
                          r="6.5"
                          stroke="var(--red)"
                          strokeWidth="1"
                        />
                        <path
                          d="M5 5L9 9M9 5L5 9"
                          stroke="var(--red)"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      <span className="step-dot" />
                    )}
                  </span>
                  <span className="step-label">{step.label}</span>
                  {step.detail && step.status === "installing" && (
                    <span className="step-detail">{step.detail}</span>
                  )}
                </li>
              ))}
            </ul>

            {activeStep?.detail && (
              <p className="active-detail">{activeStep.detail}</p>
            )}
          </div>
        )}

        {/* ── Complete ────────────────────────────────────── */}
        {isComplete && (
          <div className="complete-body">
            {desktopRunning ? (
              <span className="status-dot status-dot--running" />
            ) : (
              <span className="status-dot status-dot--stopped" />
            )}
            <p className="complete-title">
              {desktopRunning ? "Stella is running" : "Stella is ready"}
            </p>
            <p className="complete-path">{state.installPath}</p>
            {state.warningMessage && (
              <div className="banner banner-warn" style={{ marginTop: 16 }}>
                {state.warningMessage}
              </div>
            )}
            {state.errorMessage && (
              <div className="banner banner-error" style={{ marginTop: 16 }}>
                {state.errorMessage}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        {isSetup && (
          <button
            type="button"
            className="btn-primary"
            disabled={!canInstall}
            onClick={() => void handleInstall()}
          >
            {state.phase === "error" ? "Retry" : "Install"}
          </button>
        )}

        {isWorking && (
          <button type="button" className="btn-primary" disabled>
            {state.phase === "checking"
              ? "Checking..."
              : `Installing · ${progress}%`}
          </button>
        )}

        {isComplete && (
          <>
            <button
              type="button"
              className="btn-primary"
              disabled={!state.canLaunch || desktopRunning}
              onClick={() => void handleLaunch()}
            >
              {desktopRunning ? "Launching..." : "Launch Stella"}
            </button>
            <div className="footer-links">
              <button
                type="button"
                className="link-btn"
                onClick={() => void handleOpenFolder()}
              >
                Open folder
              </button>
              {state.installed && !desktopRunning && (
                <button
                  type="button"
                  className="link-btn link-danger"
                  onClick={() => void handleUninstall()}
                >
                  Uninstall
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

export default App;
