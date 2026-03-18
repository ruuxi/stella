import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	BrowserView,
	BrowserWindow,
	Tray,
	Utils,
} from "electrobun/bun";
import Electrobun from "electrobun/bun";
import type { LauncherRPC } from "../shared/types";
import { ensureLauncherRecoveryArtifacts } from "./recovery";
import {
	checkAll,
	createSetupContext,
	createSetupState,
	getLaunchInfo,
	installAll,
	setInstallPath,
	setRunAfterInstall,
	uninstall,
} from "./setup";

const defaultInstallPath = path.join(Utils.paths.home, "Stella");

await mkdir(Utils.paths.userData, { recursive: true });

const setupContext = createSetupContext({
	defaultInstallPath,
	settingsFilePath: path.join(Utils.paths.userData, "installer-settings.json"),
});
const recoveryDir = path.join(Utils.paths.userData, "recovery");
const RECOVERY_ERROR_PREFIX = "Launcher recovery check failed:";

let setupState = await createSetupState(setupContext);
let desktopProcess: ReturnType<typeof Bun.spawn> | null = null;

function getMainViewUrl(): string {
	return "views://mainview/index.html";
}

const sendInstallerState = () => {
	mainWindow.webview.rpc?.send.installerStateUpdate({ state: setupState });
};

const clearRecoveryError = () => {
	if (setupState.errorMessage?.startsWith(RECOVERY_ERROR_PREFIX)) {
		setupState = {
			...setupState,
			errorMessage: undefined,
		};
	}
};

async function syncRecoveryArtifacts() {
	const info = await getLaunchInfo(setupState);
	if (!info) {
		clearRecoveryError();
		return;
	}

	const recovery = await ensureLauncherRecoveryArtifacts({
		recoveryDir,
		desktopDir: info.cwd,
	});

	if (recovery.ok) {
		clearRecoveryError();
		return;
	}

	setupState = {
		...setupState,
		canLaunch: false,
		errorMessage: `${RECOVERY_ERROR_PREFIX} ${recovery.errorMessage}`,
	};
}

async function syncInstallerState() {
	await checkAll(setupState, setupContext, (nextState) => {
		setupState = { ...nextState };
		sendInstallerState();
	});
	await syncRecoveryArtifacts();
	sendInstallerState();
}

async function browseForInstallLocation() {
	const [selectedPath] = await Utils.openFileDialog({
		startingFolder: setupState.installPath,
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});

	if (!selectedPath) {
		return setupState;
	}

	await setInstallPath(setupState, setupContext, selectedPath);
	await syncInstallerState();
	return setupState;
}

async function startDesktop() {
	if (desktopProcess) return;

	const info = await getLaunchInfo(setupState);
	if (!info) return;

	const recovery = await ensureLauncherRecoveryArtifacts({
		recoveryDir,
		desktopDir: info.cwd,
	});
	if (!recovery.ok) {
		setupState = {
			...setupState,
			canLaunch: false,
			errorMessage: `${RECOVERY_ERROR_PREFIX} ${recovery.errorMessage}`,
		};
		sendInstallerState();
		throw new Error(recovery.errorMessage);
	}

	clearRecoveryError();
	sendInstallerState();

	desktopProcess = Bun.spawn(info.command, {
		cwd: info.cwd,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env },
	});

	desktopProcess.exited.then((code) => {
		console.log(`Desktop process exited with code ${code}`);
		desktopProcess = null;
	});
}

function stopDesktop() {
	if (!desktopProcess) return;

	desktopProcess.kill();
	desktopProcess = null;
}

const rpc = BrowserView.defineRPC<LauncherRPC>({
	maxRequestTime: 30_000,
	handlers: {
		requests: {
			getInstallerState: async () => {
				await syncInstallerState();
				return setupState;
			},

			browseInstallLocation: async () => browseForInstallLocation(),

			setInstallLocation: async ({ path: nextPath }) => {
				await setInstallPath(setupState, setupContext, nextPath);
				await syncInstallerState();
				return setupState;
			},

			setRunAfterInstall: async ({ value }) => {
				await setRunAfterInstall(setupState, setupContext, value);
				sendInstallerState();
				return setupState;
			},

			startInstall: async () => {
				const result = await installAll(
					setupState,
					setupContext,
					(nextState) => {
						setupState = { ...nextState };
						sendInstallerState();
					},
				);

				if (result.ok && setupState.runAfterInstall && setupState.canLaunch) {
					await startDesktop();
				}

				return { ok: result.ok };
			},

			launchDesktop: async () => {
				try {
					await startDesktop();
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			openInstallLocation: async () => ({
				ok: Utils.openPath(setupState.installPath),
			}),

			uninstallStella: async () => {
				const result = await uninstall(setupState);
				if (result.ok) {
					await syncInstallerState();
				}
				return result;
			},
		},
		messages: {},
	},
});

const url = getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Stella",
	url,
	rpc,
	frame: {
		width: 560,
		height: 720,
		x: 200,
		y: 120,
	},
});

const trayImage =
	process.platform === "win32"
		? "views://assets/tray-icon.ico"
		: "views://assets/tray-icon.png";

const tray = new Tray({
	title: "Stella",
	image: trayImage,
	width: 22,
	height: 22,
});

tray.setMenu([
	{ type: "normal", label: "Open Stella", action: "open" },
	{ type: "divider" },
	{ type: "normal", label: "Quit", action: "quit" },
]);

Electrobun.events.on("tray-item-clicked", (event) => {
	if (event.data.action === "open") {
		mainWindow.focus();
		return;
	}

	if (event.data.action === "quit") {
		stopDesktop();
		Utils.quit();
	}
});

Electrobun.events.on("before-quit", () => {
	stopDesktop();
});

mainWindow.webview.on("dom-ready", () => {
	void syncInstallerState();
});

console.log("Stella launcher started");
