import {
	startTransition,
	useCallback,
	useEffect,
	useState,
} from "react";
import { Electroview } from "electrobun/view";
import type { InstallerState, LauncherRPC, SetupStep } from "../shared/types";

const rpc = Electroview.defineRPC<LauncherRPC>({
	handlers: {
		requests: {},
		messages: {
			installerStateUpdate: () => {},
		},
	},
});

const electroview = new Electroview({ rpc });

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

/* ── Step indicator ──────────────────────────────────────────────── */

function StepItem({ step }: { step: SetupStep }) {
	const isDone = step.status === "done" || step.status === "skipped";
	const isActive =
		step.status === "installing" || step.status === "checking";
	const isFailed = step.status === "error";

	return (
		<div className="step-row">
			<span className="step-icon">
				{isDone ? (
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path
							d="M2.5 7.5L5.5 10.5L11.5 3.5"
							stroke="#4aba6a"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				) : isActive ? (
					<span className="spinner" />
				) : isFailed ? (
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path
							d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
							stroke="#e45858"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				) : (
					<span className="step-pending" />
				)}
			</span>
			<span
				className={`step-label ${isDone ? "done" : ""} ${isActive ? "active" : ""} ${isFailed ? "failed" : ""}`}
			>
				{step.label}
			</span>
		</div>
	);
}

/* ── App ─────────────────────────────────────────────────────────── */

function App() {
	const [state, setState] = useState<InstallerState | null>(null);
	const [installPathDraft, setInstallPathDraft] = useState("");
	const [locationBusy, setLocationBusy] = useState(false);

	const applyState = useCallback((nextState: InstallerState) => {
		startTransition(() => setState(nextState));
	}, []);

	useEffect(() => {
		if (state) setInstallPathDraft(state.installPath);
	}, [state?.installPath]);

	useEffect(() => {
		const r = electroview.rpc;
		if (!r) return;
		const handle = ({ state: s }: { state: InstallerState }) =>
			applyState(s);
		r.addMessageListener("installerStateUpdate", handle);
		void r.request.getInstallerState({}).then(applyState);
		return () => r.removeMessageListener("installerStateUpdate", handle);
	}, [applyState]);

	const commitInstallPath = useCallback(async () => {
		if (!electroview.rpc || !state) return;
		const nextPath = installPathDraft.trim();
		if (!nextPath || nextPath === state.installPath) return;
		setLocationBusy(true);
		try {
			applyState(
				await electroview.rpc.request.setInstallLocation({
					path: nextPath,
				}),
			);
		} finally {
			setLocationBusy(false);
		}
	}, [applyState, installPathDraft, state]);

	const handleBrowse = useCallback(async () => {
		if (!electroview.rpc) return;
		setLocationBusy(true);
		try {
			applyState(
				await electroview.rpc.request.browseInstallLocation({}),
			);
		} finally {
			setLocationBusy(false);
		}
	}, [applyState]);

	const handleUseDefaultLocation = useCallback(async () => {
		if (!electroview.rpc || !state) return;
		setInstallPathDraft(state.defaultInstallPath);
		setLocationBusy(true);
		try {
			applyState(
				await electroview.rpc.request.setInstallLocation({
					path: state.defaultInstallPath,
				}),
			);
		} finally {
			setLocationBusy(false);
		}
	}, [applyState, state]);

	const handleRunAfterInstallChange = useCallback(
		async (checked: boolean) => {
			if (!electroview.rpc) return;
			applyState(
				await electroview.rpc.request.setRunAfterInstall({
					value: checked,
				}),
			);
		},
		[applyState],
	);

	const handleInstall = useCallback(async () => {
		if (!electroview.rpc) return;
		await commitInstallPath();
		await electroview.rpc.request.startInstall({});
	}, [commitInstallPath]);

	const handleLaunch = useCallback(async () => {
		if (!electroview.rpc) return;
		await electroview.rpc.request.launchDesktop({});
	}, []);

	const handleOpenFolder = useCallback(async () => {
		if (!electroview.rpc) return;
		await electroview.rpc.request.openInstallLocation({});
	}, []);

	const handleUninstall = useCallback(async () => {
		if (!electroview.rpc) return;
		if (
			!window.confirm(
				"This will remove Stella and its shortcuts. Continue?",
			)
		)
			return;
		await electroview.rpc.request.uninstallStella({});
	}, []);

	/* ── Loading ─────────────────────────────────────────────────── */

	if (!state) {
		return (
			<div className="shell">
				<div className="shell-loading">
					<span className="spinner" />
				</div>
			</div>
		);
	}

	const isSetup =
		state.phase === "ready" || state.phase === "error";
	const isWorking =
		state.phase === "installing" || state.phase === "checking";
	const isComplete = state.phase === "complete";

	const canInstall =
		isSetup &&
		!state.installPathError &&
		state.disk.enoughSpace &&
		!locationBusy;

	/* ── Render ──────────────────────────────────────────────────── */

	return (
		<div className="shell">
			{/* Header — always visible */}
			<header className="header">
				<svg
					className="header-mark"
					width="20"
					height="20"
					viewBox="0 0 20 20"
					fill="none"
				>
					<circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.2" />
					<circle cx="10" cy="10" r="3" fill="currentColor" />
				</svg>
				<h1 className="header-title">Stella</h1>
			</header>

			{/* Body */}
			<main className="body">
				{/* ── Ready / Error ───────────────────────────────── */}
				{isSetup && (
					<>
						<p className="heading">
							Choose where to install Stella.
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
										{formatBytes(
											state.disk.requiredBytes,
										)}{" "}
										needed &middot;{" "}
										{formatBytes(
											state.disk.availableBytes,
										)}{" "}
										available
									</span>
								)}
								<button
									type="button"
									className="link-btn"
									onClick={() =>
										void handleUseDefaultLocation()
									}
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
									void handleRunAfterInstallChange(
										e.target.checked,
									)
								}
							/>
							<span>Launch Stella when finished</span>
						</label>
					</>
				)}

				{/* ── Installing / Checking ───────────────────────── */}
				{isWorking && (
					<>
						<p className="heading">
							{state.phase === "checking"
								? "Checking..."
								: "Installing Stella"}
						</p>
						<div className="steps">
							{state.steps.map((step) => (
								<StepItem key={step.id} step={step} />
							))}
						</div>
					</>
				)}

				{/* ── Complete ────────────────────────────────────── */}
				{isComplete && (
					<div className="complete-body">
						<svg
							className="complete-check"
							width="36"
							height="36"
							viewBox="0 0 36 36"
							fill="none"
						>
							<circle
								cx="18"
								cy="18"
								r="17"
								stroke="#4aba6a"
								strokeWidth="1.2"
							/>
							<path
								d="M11 18.5L15.5 23L25 13"
								stroke="#4aba6a"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
						<p className="complete-title">Stella is ready</p>
						<p className="complete-path">{state.installPath}</p>
					</div>
				)}
			</main>

			{/* Footer — always visible */}
			<footer className="footer">
				{isSetup && (
					<button
						type="button"
						className="btn-primary"
						disabled={!canInstall}
						onClick={() => void handleInstall()}
					>
						{state.phase === "error"
							? "Retry"
							: "Install"}
					</button>
				)}

				{isWorking && (
					<button
						type="button"
						className="btn-primary"
						disabled
					>
						Installing...
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
