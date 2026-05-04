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
import { ask } from "@tauri-apps/plugin-dialog";
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
  const [uninstalling, setUninstalling] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const [upToDateFlash, setUpToDateFlash] = useState(false);
  const desktopWasRunningRef = useRef(false);

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
    const poll = async () => {
      try {
        const running = await invoke<boolean>("is_desktop_running");
        const wasRunning = desktopWasRunningRef.current;
        desktopWasRunningRef.current = running;
        setDesktopRunning(running);

        if (wasRunning && !running) {
          await invoke("show_launcher_window");
        }
      } catch {}
    };
    void poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [state?.phase]);

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
    await invoke("start_install");
  }, [commitInstallPath]);

  const handleLaunch = useCallback(async () => {
    await invoke<{ ok: boolean }>("launch_desktop");
  }, []);

  const handleOpenFolder = useCallback(async () => {
    await invoke("open_install_location");
  }, []);

  const handleLauncherUpdate = useCallback(async () => {
    try {
      await invoke("apply_launcher_update");
    } catch {}
  }, []);

  const handleCheckLauncherUpdate = useCallback(async () => {
    setUpToDateFlash(false);
    try {
      const updateAvailable = await invoke<boolean>("check_launcher_update");
      if (!updateAvailable) {
        setUpToDateFlash(true);
        window.setTimeout(() => setUpToDateFlash(false), 4000);
      }
    } catch {}
  }, []);

  const handleReinstall = useCallback(async () => {
    const confirmed = await ask(
      "This will replace Stella with a fresh copy. Any customizations Stella has made to itself \u2014 mods, skills, and agent-edited code \u2014 will be reset.\n\nYour chats, memories, and settings will be kept.",
      {
        title: "Reinstall Stella?",
        kind: "warning",
        okLabel: "Reinstall",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;
    setReinstalling(true);
    try {
      await invoke("uninstall_stella");
      await invoke("start_install");
    } finally {
      setReinstalling(false);
    }
  }, []);

  const handleUninstall = useCallback(async () => {
    const confirmed = await ask(
      "This will remove the Stella app from your computer. Any customizations Stella has made to itself \u2014 mods, skills, and agent-edited code \u2014 will be lost.\n\nYour chats, memories, and settings will be kept on disk in case you reinstall later.",
      {
        title: "Uninstall Stella?",
        kind: "warning",
        okLabel: "Uninstall",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;
    setUninstalling(true);
    try {
      await invoke("uninstall_stella");
    } finally {
      setUninstalling(false);
    }
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
    const activeProgress =
      typeof active?.progress === "number"
        ? Math.max(0, Math.min(active.progress, 1))
        : 0.5;
    const inProgress = active ? stepWeight * activeProgress : 0;

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
  const isWorking =
    state.phase === "installing" ||
    state.phase === "checking" ||
    state.phase === "updating";
  const isComplete = state.phase === "complete";

  const canInstall =
    isSetup &&
    !state.devMode &&
    !state.installPathError &&
    state.disk.enoughSpace &&
    !locationBusy;

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className={`shell${isComplete ? " shell--complete" : ""}`}>
      <div className="drag-region" />

      {/* Brand header — always visible */}
      <div className="brand">
        <img src={stellaLogo} alt="Stella" className="brand-logo" />
        <h1 className="brand-name">Stella</h1>
      </div>

      {/* Body */}
      <main className="body" key={state.phase}>
        {/* ── Ready / Error ───────────────────────────────── */}
        {isSetup && (
          <>
            <p className="status-text">
              {state.devMode
                ? "Using local Stella desktop checkout"
                : "Choose where Stella should live"}
            </p>

            <div className="field-group">
              <label className="field-label">Folder</label>
              <div className="path-row">
                <input
                  className="path-input"
                  value={installPathDraft}
                  readOnly={state.installPathLocked}
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
                  className="btn-icon"
                  onClick={() => void handleBrowse()}
                  disabled={locationBusy || state.installPathLocked}
                  aria-label="Choose folder"
                  title="Choose folder"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 4.25C2 3.56 2.56 3 3.25 3h3.04c.33 0 .65.13.88.37l1.12 1.13h4.46c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3.25C2.56 13.5 2 12.94 2 12.25v-8z"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>

              <div className="field-meta">
                {state.installPathError ? (
                  <span className="field-error">{state.installPathError}</span>
                ) : (
                  <span className="field-hint">
                    {state.devMode
                      ? "Dev mode is using the path from STELLA_LAUNCHER_DEV or STELLA_LAUNCHER_DEV_PATH."
                      : `${formatBytes(state.disk.requiredBytes)} needed \u00b7 ${formatBytes(state.disk.availableBytes)} available`}
                  </span>
                )}
                {!state.installPathLocked && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void handleUseDefaultLocation()}
                    disabled={locationBusy}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {!state.devMode && !state.disk.enoughSpace && (
              <div className="banner banner-warn">
                Not enough disk space at this location.
              </div>
            )}

            {state.devMode && !state.canLaunch && (
              <div className="banner banner-warn">
                Dev mode is enabled, but this path is not launchable yet. Make
                sure the Stella folder has its root package file and installed
                dependencies.
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
            {state.warningMessage && (
              <div className="banner banner-warn" style={{ marginTop: 16 }}>
                {state.warningMessage}
              </div>
            )}
            {state.launcherUpdate.available && (
              <div className="banner banner-warn" style={{ marginTop: 16 }}>
                {state.launcherUpdate.version
                  ? `Launcher update ${state.launcherUpdate.version} is available.`
                  : "A launcher update is available."}
              </div>
            )}
            {state.launcherUpdate.error && (
              <div className="banner banner-error" style={{ marginTop: 16 }}>
                {state.launcherUpdate.error}
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
        {upToDateFlash && !state.launcherUpdate.available && (
          <div className="banner banner-info">
            You’re on the latest launcher.
          </div>
        )}
        <div className="footer-primary" key={`primary-${state.phase}`}>
          {isSetup && !state.devMode && (
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
                : state.phase === "updating"
                  ? "Updating..."
                  : `Installing · ${progress}%`}
            </button>
          )}

          {isComplete &&
            (state.launcherUpdate.available ? (
              <button
                type="button"
                className="btn-primary"
                disabled={state.launcherUpdate.installing || uninstalling}
                onClick={() => void handleLauncherUpdate()}
              >
                {state.launcherUpdate.installing
                  ? "Updating launcher..."
                  : "Update launcher"}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={!state.canLaunch || desktopRunning || uninstalling}
                onClick={() => void handleLaunch()}
              >
                {desktopRunning ? "Launching..." : "Launch Stella"}
              </button>
            ))}
        </div>

        {!state.devMode && !isWorking && (
          <div className="footer-links">
            {isComplete && (
              <button
                type="button"
                className="link-btn"
                onClick={() => void handleOpenFolder()}
                disabled={uninstalling || reinstalling}
              >
                Open folder
              </button>
            )}
            {!state.launcherUpdate.available && (
              <button
                type="button"
                className="link-btn"
                onClick={() => void handleCheckLauncherUpdate()}
                disabled={
                  state.launcherUpdate.checking ||
                  state.launcherUpdate.installing ||
                  uninstalling ||
                  reinstalling
                }
              >
                {state.launcherUpdate.checking
                  ? "Checking..."
                  : state.launcherUpdate.lastCheckedAtMs > 0 &&
                      !state.launcherUpdate.error
                    ? "Up to date \u00b7 Update"
                    : "Update"}
              </button>
            )}
            {isComplete && state.installed && !desktopRunning && (
                <>
                  <button
                    type="button"
                    className="link-btn link-btn--with-spinner"
                    onClick={() => void handleReinstall()}
                    disabled={uninstalling || reinstalling}
                  >
                    {reinstalling && <span className="link-spinner" />}
                    {reinstalling ? "Reinstalling..." : "Reinstall"}
                  </button>
                  <button
                    type="button"
                    className="link-btn link-danger link-btn--with-spinner"
                    onClick={() => void handleUninstall()}
                    disabled={uninstalling || reinstalling}
                  >
                    {uninstalling && <span className="link-spinner" />}
                    {uninstalling ? "Uninstalling..." : "Uninstall"}
                  </button>
                </>
              )}
          </div>
        )}
      </footer>
    </div>
  );
}

export default App;
