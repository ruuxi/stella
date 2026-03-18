import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { InstallerState } from "./types";
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
	const [autoLaunching, setAutoLaunching] = useState(false);

	const applyState = useCallback((nextState: InstallerState) => {
		startTransition(() => setState(nextState));
	}, []);

	useEffect(() => {
		if (state) setInstallPathDraft(state.installPath);
	}, [state?.installPath]);

	// Auto-launch if already installed
	useEffect(() => {
		if (!state || autoLaunching) return;
		if (state.phase === "complete" && state.canLaunch && state.installed) {
			setAutoLaunching(true);
			invoke("launch_desktop").then(() => {
				// Close the launcher window after a brief delay
				setTimeout(() => window.close(), 1500);
			});
		}
	}, [state, autoLaunching]);

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
			applyState(
				await invoke<InstallerState>("browse_install_location"),
			);
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

	const handleRunAfterInstallChange = useCallback(
		async (checked: boolean) => {
			applyState(
				await invoke<InstallerState>("set_run_after_install", {
					value: checked,
				}),
			);
		},
		[applyState],
	);

	const handleInstall = useCallback(async () => {
		await commitInstallPath();
		await invoke("start_install");
	}, [commitInstallPath]);

	const handleLaunch = useCallback(async () => {
		await invoke("launch_desktop");
	}, []);

	const handleOpenFolder = useCallback(async () => {
		await invoke("open_install_location");
	}, []);

	const handleUninstall = useCallback(async () => {
		if (
			!window.confirm(
				"This will remove Stella and its data. Continue?",
			)
		)
			return;
		await invoke("uninstall_stella");
	}, []);

	/* ── Derived ─────────────────────────────────────────────────── */

	const progress = useMemo(() => {
		if (!state) return 0;
		const total = state.steps.length;
		if (total === 0) return 0;
		const done = state.steps.filter(
			(s) => s.status === "done" || s.status === "skipped",
		).length;
		return Math.round((done / total) * 100);
	}, [state]);

	const activeStepLabel = useMemo(() => {
		if (!state) return "";
		const active = state.steps.find(
			(s) => s.status === "installing" || s.status === "checking",
		);
		return active?.label ?? "";
	}, [state]);

	/* ── Loading / splash ────────────────────────────────────────── */

	if (!state || autoLaunching) {
		return (
			<div className="shell">
				<div className="drag-region" />
				<div className="brand">
					<img src={stellaLogo} alt="Stella" className="brand-logo" />
					<h1 className="brand-name">Stella</h1>
				</div>
				<div className="body" style={{ alignItems: "center", justifyContent: "center" }}>
					<p className="status-text">
						{autoLaunching ? "Launching..." : "Loading..."}
					</p>
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
						<p className="status-text">
							Choose where to install Stella
						</p>

						<div className="field-group">
							<label className="field-label">Location</label>
							<div className="path-row">
								<input
									className="path-input"
									value={installPathDraft}
									onChange={(e) =>
										setInstallPathDraft(e.target.value)
									}
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
									<span className="field-error">
										{state.installPathError}
									</span>
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
							<div className="banner banner-error">
								{state.errorMessage}
							</div>
						)}

						<label className="checkbox-row">
							<input
								type="checkbox"
								checked={state.runAfterInstall}
								onChange={(e) =>
									void handleRunAfterInstallChange(e.target.checked)
								}
							/>
							<span>Launch Stella when finished</span>
						</label>
					</>
				)}

				{/* ── Installing / Checking ───────────────────────── */}
				{isWorking && (
					<div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1 }}>
						<p className="status-text">
							{activeStepLabel || (state.phase === "checking" ? "Checking..." : "Setting up...")}
						</p>
						<div className="progress-wrap">
							<div className="progress-track">
								<div
									className={`progress-fill ${state.phase === "checking" ? "indeterminate" : ""}`}
									style={state.phase !== "checking" ? { width: `${progress}%` } : undefined}
								/>
							</div>
						</div>
					</div>
				)}

				{/* ── Complete ────────────────────────────────────── */}
				{isComplete && (
					<div className="complete-body">
						<svg width="36" height="36" viewBox="0 0 36 36" fill="none" style={{ marginBottom: 16, color: "var(--green)" }}>
							<circle cx="18" cy="18" r="17" stroke="currentColor" strokeWidth="1.2" />
							<path d="M11 18.5L15.5 23L25 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
						<p className="complete-title">Stella is ready</p>
						<p className="complete-path">{state.installPath}</p>
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
						Setting up...
					</button>
				)}

				{isComplete && (
					<>
						<button
							type="button"
							className="btn-primary"
							disabled={!state.canLaunch}
							onClick={() => void handleLaunch()}
						>
							Launch Stella
						</button>
						<div className="footer-links">
							<button
								type="button"
								className="link-btn"
								onClick={() => void handleOpenFolder()}
							>
								Open folder
							</button>
							{state.installed && (
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
