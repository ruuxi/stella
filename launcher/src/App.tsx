import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopFailure, InstallerState, SetupStep } from "./types";
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

/* ── In-app confirmation dialog ──────────────────────────────────── */

type ConfirmStep = {
  title: string;
  body: string;
  confirmLabel: string;
  /** When true, the confirm button is rendered in the destructive (red) style. */
  danger?: boolean;
};

type ConfirmDialogProps = {
  steps: ConfirmStep[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  busyLabel?: string;
};

const ConfirmDialog = ({
  steps,
  onCancel,
  onConfirm,
  busy = false,
  busyLabel,
}: ConfirmDialogProps) => {
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];
  if (!step) return null;
  const isFinalStep = stepIndex === steps.length - 1;

  const handlePrimary = () => {
    if (busy) return;
    if (isFinalStep) {
      void onConfirm();
    } else {
      setStepIndex(stepIndex + 1);
    }
  };

  const handleSecondary = () => {
    if (busy) return;
    if (stepIndex === 0) {
      onCancel();
    } else {
      setStepIndex(stepIndex - 1);
    }
  };

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog-card">
        <h2 className="dialog-title">{step.title}</h2>
        <p className="dialog-body">{step.body}</p>
        {steps.length > 1 && (
          <p className="dialog-step">
            Step {stepIndex + 1} of {steps.length}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-btn dialog-btn--secondary"
            onClick={handleSecondary}
            disabled={busy}
          >
            {stepIndex === 0 ? "Cancel" : "Back"}
          </button>
          <button
            type="button"
            className={`dialog-btn dialog-btn--primary${
              step.danger ? " dialog-btn--danger" : ""
            }`}
            onClick={handlePrimary}
            disabled={busy}
          >
            {busy && isFinalStep ? (
              <>
                <span className="link-spinner" />
                {busyLabel ?? "Working..."}
              </>
            ) : (
              step.confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── App ─────────────────────────────────────────────────────────── */

type SettingsAction = "reinstall" | "uninstall" | "full-reset";

function App() {
  const [state, setState] = useState<InstallerState | null>(null);
  const [installPathDraft, setInstallPathDraft] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const [view, setView] = useState<"main" | "settings">("main");
  const [pendingAction, setPendingAction] = useState<SettingsAction | null>(
    null,
  );
  const [failure, setFailure] = useState<DesktopFailure | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<
    "idle" | "retrying" | "reverting" | "revertFailed"
  >("idle");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [showFailureDetails, setShowFailureDetails] = useState(false);

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

  // Recovery view: the launcher's Rust side emits `desktop-failure` when
  // `bun run electron:dev` exits with a non-zero status. Switching into
  // this state takes priority over the install/launch UI -- the recovery
  // card stays visible until the user clicks Try again or undoes the
  // last update (both flows clear the failure on the Rust side).
  useEffect(() => {
    invoke<DesktopFailure | null>("get_desktop_failure")
      .then((next) => {
        if (next) {
          setFailure(next);
          setShowFailureDetails(false);
          setRecoveryAction("idle");
          setRecoveryError(null);
        }
      })
      .catch(() => {});
    const unlisten = listen<DesktopFailure>("desktop-failure", (event) => {
      setFailure(event.payload);
      setShowFailureDetails(false);
      setRecoveryAction("idle");
      setRecoveryError(null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Poll desktop running state for UI display only. The launcher's Rust side
  // owns the "desktop exited → re-show launcher" transition (see
  // start_desktop_watcher in commands.rs) because this webview is suspended
  // while the launcher window is hidden.
  useEffect(() => {
    if (!state || state.phase !== "complete") return;
    const poll = async () => {
      try {
        const running = await invoke<boolean>("is_desktop_running");
        setDesktopRunning(running);
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

  const handleReinstall = useCallback(async () => {
    setReinstalling(true);
    try {
      await invoke("uninstall_stella");
      await invoke("start_install");
    } finally {
      setReinstalling(false);
      setPendingAction(null);
      setView("main");
    }
  }, []);

  const handleUninstall = useCallback(async () => {
    setUninstalling(true);
    try {
      await invoke("uninstall_stella");
    } finally {
      setUninstalling(false);
      setPendingAction(null);
      setView("main");
    }
  }, []);

  const handleFullReset = useCallback(async () => {
    setErasing(true);
    try {
      await invoke("full_reset_stella");
    } finally {
      setErasing(false);
      setPendingAction(null);
      setView("main");
    }
  }, []);

  /* ── Recovery actions ────────────────────────────────────────── */

  const handleRecoveryRetry = useCallback(async () => {
    setRecoveryAction("retrying");
    setRecoveryError(null);
    try {
      await invoke<{ ok: boolean }>("launch_desktop");
      // launch_desktop clears the captured failure on the Rust side;
      // mirror that locally so we exit the recovery view immediately
      // and the desktop-failure listener takes over from here.
      setFailure(null);
    } catch (err) {
      setRecoveryAction("idle");
      setRecoveryError(
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Couldn't relaunch Stella.",
      );
    }
  }, []);

  const handleRecoveryRevert = useCallback(async () => {
    setRecoveryAction("reverting");
    setRecoveryError(null);
    try {
      await invoke("revert_last_self_mod");
      // After a successful revert, immediately try to relaunch so the
      // user lands back in Stella instead of staring at the recovery
      // view. If the relaunch itself fails, the failure listener
      // captures the new state.
      await invoke("clear_desktop_failure");
      setFailure(null);
      await invoke<{ ok: boolean }>("launch_desktop");
    } catch (err) {
      setRecoveryAction("revertFailed");
      setRecoveryError(
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Couldn't roll back the last update.",
      );
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

  const updateAvailable = !state.devMode && state.launcherUpdate.available;
  const showLauncherUpdateBusy =
    !state.devMode && state.launcherUpdate.installing;
  const settingsOpen = view === "settings" && !state.devMode;
  const anyDialogBusy = uninstalling || reinstalling || erasing;

  const dialogStepsForAction = (
    action: SettingsAction,
  ): { steps: ConfirmStep[]; busy: boolean; busyLabel: string; onConfirm: () => Promise<void> } => {
    switch (action) {
      case "reinstall":
        return {
          steps: [
            {
              title: "Reinstall Stella?",
              body: "This replaces Stella with a fresh copy. Mods, skills, and any code Stella wrote for you reset. Your chats, memories, and settings are kept.",
              confirmLabel: "Continue",
            },
            {
              title: "You'll lose Stella's customizations.",
              body: "Stella has built itself up over time. Reinstalling resets every feature Stella added or modified. Your data stays.",
              confirmLabel: "Reinstall",
            },
          ],
          busy: reinstalling,
          busyLabel: "Reinstalling...",
          onConfirm: handleReinstall,
        };
      case "uninstall":
        return {
          steps: [
            {
              title: "Uninstall Stella?",
              body: "This removes the Stella app from your computer. Your chats, memories, and settings stay on disk in case you reinstall later.",
              confirmLabel: "Continue",
            },
            {
              title: "Stella's customizations will be lost.",
              body: "If you reinstall later, you'll get a fresh Stella. Your saved conversations and memory will still be there.",
              confirmLabel: "Uninstall",
            },
          ],
          busy: uninstalling,
          busyLabel: "Uninstalling...",
          onConfirm: handleUninstall,
        };
      case "full-reset":
        return {
          steps: [
            {
              title: "Erase everything?",
              body: "This wipes the entire Stella folder. Your chats, memories, settings, mods, skills — everything Stella has ever saved — will be permanently deleted.",
              confirmLabel: "Continue",
              danger: true,
            },
            {
              title: "Last chance.",
              body: "Once you erase, your conversations and memories are gone for good. Stella can't bring them back. Are you sure?",
              confirmLabel: "Erase everything",
              danger: true,
            },
          ],
          busy: erasing,
          busyLabel: "Erasing...",
          onConfirm: handleFullReset,
        };
    }
  };

  const activeDialog = pendingAction ? dialogStepsForAction(pendingAction) : null;

  /* ── Recovery view ───────────────────────────────────────────── */

  if (failure) {
    const couldntStart = !failure.reachedRunning;
    const headline = couldntStart ? "Stella didn't start" : "Stella crashed";
    const sub = couldntStart
      ? "An update broke something while booting. You can try again, or roll back the last change Stella made to itself."
      : "Stella started, then ran into an error. You can reload, or roll back the last change Stella made to itself.";
    const retrying = recoveryAction === "retrying";
    const reverting = recoveryAction === "reverting";
    const busy = retrying || reverting;
    const canRevert = !!failure.revertableCommit;
    const revertSubject = failure.revertableCommit?.subject ?? "";
    const revertSha = failure.revertableCommit?.shortSha ?? "";
    return (
      <div className="shell shell--complete">
        <div className="drag-region" />
        <div className="brand">
          <img src={stellaLogo} alt="Stella" className="brand-logo" />
          <h1 className="brand-name">Stella</h1>
        </div>
        <main className="body recovery-view" key="recovery">
          <h2 className="recovery-title">{headline}</h2>
          <p className="recovery-sub">{sub}</p>
          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-btn recovery-btn--primary"
              onClick={handleRecoveryRetry}
              disabled={busy}
            >
              {retrying ? (
                <>
                  <span className="link-spinner" />
                  Reloading...
                </>
              ) : (
                "Try again"
              )}
            </button>
            {canRevert && (
              <button
                type="button"
                className="recovery-btn"
                onClick={handleRecoveryRevert}
                disabled={busy}
                title={`Reverts ${revertSha}: ${revertSubject}`}
              >
                {reverting ? (
                  <>
                    <span className="link-spinner" />
                    Undoing...
                  </>
                ) : (
                  "Undo Stella's last update"
                )}
              </button>
            )}
          </div>
          {canRevert && (
            <p className="recovery-revert-hint">
              Will roll back: <em>{revertSubject || revertSha}</em>
            </p>
          )}
          {!canRevert && (
            <p className="recovery-revert-hint">
              The latest change isn't a Stella self-update, so it won't be
              rolled back automatically. If "Try again" doesn't work, use
              Settings → Reinstall.
            </p>
          )}
          {recoveryError && (
            <p className="recovery-error">{recoveryError}</p>
          )}
          <div className="recovery-details">
            <button
              type="button"
              className="link-btn recovery-details-toggle"
              onClick={() => setShowFailureDetails((v) => !v)}
            >
              {showFailureDetails ? "Hide details" : "Show details"}
            </button>
            {showFailureDetails && (
              <pre className="recovery-log">
                {failure.logTail || "(no log output captured)"}
              </pre>
            )}
            <p className="recovery-log-path">{failure.logPath}</p>
          </div>
        </main>
      </div>
    );
  }

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
      {settingsOpen ? (
        <main className="body settings-view" key="settings">
          <div className="settings-header">
            <button
              type="button"
              className="link-btn settings-back"
              onClick={() => {
                setPendingAction(null);
                setView("main");
              }}
            >
              ← Back
            </button>
            <span className="settings-title">Settings</span>
          </div>

          <div className="settings-list">
            <SettingsRow
              title="Reinstall"
              body="Replace Stella with a fresh copy. Your chats and memories stay; Stella's customizations reset."
              actionLabel="Reinstall"
              onAction={() => setPendingAction("reinstall")}
              busy={reinstalling}
              busyLabel="Reinstalling..."
              disabled={anyDialogBusy && !reinstalling}
            />
            <SettingsRow
              title="Uninstall"
              body="Remove the Stella app from your computer. Your data stays on disk in case you reinstall."
              actionLabel="Uninstall"
              onAction={() => setPendingAction("uninstall")}
              busy={uninstalling}
              busyLabel="Uninstalling..."
              disabled={anyDialogBusy && !uninstalling}
            />
            <SettingsRow
              title="Erase everything"
              body="Wipe the entire Stella folder, including chats, memories, and settings. Can't be undone."
              actionLabel="Erase everything"
              onAction={() => setPendingAction("full-reset")}
              busy={erasing}
              busyLabel="Erasing..."
              danger
              disabled={anyDialogBusy && !erasing}
            />
          </div>
        </main>
      ) : (
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

          {/* ── Complete / warnings ─────────────────────────── */}
          {(isComplete || state.launcherUpdate.error) && (
            <div className="complete-body">
              {isComplete && state.warningMessage && (
                <div className="banner banner-warn" style={{ marginTop: 16 }}>
                  {state.warningMessage}
                </div>
              )}
              {state.launcherUpdate.error && (
                <div className="banner banner-error" style={{ marginTop: 16 }}>
                  {state.launcherUpdate.error}
                </div>
              )}
              {isComplete && state.errorMessage && (
                <div className="banner banner-error" style={{ marginTop: 16 }}>
                  {state.errorMessage}
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* Footer */}
      {!settingsOpen && (
        <footer className="footer">
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

            {isComplete && (
              <button
                type="button"
                className="btn-primary"
                disabled={!state.canLaunch || desktopRunning || anyDialogBusy}
                onClick={() => void handleLaunch()}
              >
                {desktopRunning ? "Launching..." : "Launch Stella"}
              </button>
            )}
          </div>

          {/* Optional, non-forced launcher-update affordance below the
              primary action. Stays visible alongside Launch instead of
              replacing it, so the user can update at their leisure. */}
          {!state.devMode && !isWorking && updateAvailable && (
            <button
              type="button"
              className="update-pill"
              onClick={() => void handleLauncherUpdate()}
              disabled={showLauncherUpdateBusy || anyDialogBusy}
            >
              <span className="update-pill-dot" aria-hidden="true" />
              <span className="update-pill-text">
                {showLauncherUpdateBusy
                  ? "Updating launcher..."
                  : state.launcherUpdate.version
                    ? `Launcher ${state.launcherUpdate.version} ready · Update`
                    : "Launcher update ready · Update"}
              </span>
            </button>
          )}

          {!state.devMode && !isWorking && (
            <div className="footer-links">
              {isComplete && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => void handleOpenFolder()}
                  disabled={anyDialogBusy}
                >
                  Open folder
                </button>
              )}
              {isComplete && state.installed && !desktopRunning && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setView("settings")}
                  disabled={anyDialogBusy}
                >
                  Settings
                </button>
              )}
            </div>
          )}
        </footer>
      )}

      {activeDialog && pendingAction && (
        <ConfirmDialog
          steps={activeDialog.steps}
          busy={activeDialog.busy}
          busyLabel={activeDialog.busyLabel}
          onCancel={() => setPendingAction(null)}
          onConfirm={activeDialog.onConfirm}
        />
      )}
    </div>
  );
}

/* ── Settings row ────────────────────────────────────────────────── */

type SettingsRowProps = {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  busy?: boolean;
  busyLabel?: string;
  danger?: boolean;
  disabled?: boolean;
};

const SettingsRow = ({
  title,
  body,
  actionLabel,
  onAction,
  busy = false,
  busyLabel,
  danger = false,
  disabled = false,
}: SettingsRowProps) => {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-title">{title}</span>
        <span className="settings-row-body">{body}</span>
      </div>
      <button
        type="button"
        className={`settings-row-btn${danger ? " settings-row-btn--danger" : ""}`}
        onClick={onAction}
        disabled={busy || disabled}
      >
        {busy ? (
          <>
            <span className="link-spinner" />
            {busyLabel ?? "Working..."}
          </>
        ) : (
          actionLabel
        )}
      </button>
    </div>
  );
};

export default App;
