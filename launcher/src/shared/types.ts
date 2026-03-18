import type { RPCSchema } from "electrobun/bun";

export type SetupStepId =
	| "runtime"
	| "prepare"
	| "payload"
	| "deps"
	| "env"
	| "browser"
	| "shortcuts"
	| "finalize";

export type SetupStepStatus =
	| "pending"
	| "checking"
	| "installing"
	| "done"
	| "skipped"
	| "error";

export type SetupStep = {
	id: SetupStepId;
	label: string;
	status: SetupStepStatus;
	detail?: string;
};

export type InstallerMode = "development" | "production";

export type InstallerPhase =
	| "checking"
	| "ready"
	| "installing"
	| "complete"
	| "error";

export type InstallerState = {
	steps: SetupStep[];
	phase: InstallerPhase;
	errorMessage?: string;
	mode: InstallerMode;
	installPath: string;
	defaultInstallPath: string;
	installPathError?: string;
	runAfterInstall: boolean;
	canLaunch: boolean;
	installed: boolean;
	disk: {
		requiredBytes: number;
		availableBytes: number | null;
		usedBytes: number;
		enoughSpace: boolean;
	};
};

export type LauncherRPC = {
	bun: RPCSchema<{
		requests: {
			getInstallerState: {
				params: {};
				response: InstallerState;
			};
			browseInstallLocation: {
				params: {};
				response: InstallerState;
			};
			setInstallLocation: {
				params: { path: string };
				response: InstallerState;
			};
			setRunAfterInstall: {
				params: { value: boolean };
				response: InstallerState;
			};
			startInstall: {
				params: {};
				response: { ok: boolean };
			};
			launchDesktop: {
				params: {};
				response: { ok: boolean };
			};
			openInstallLocation: {
				params: {};
				response: { ok: boolean };
			};
			uninstallStella: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			installerStateUpdate: { state: InstallerState };
		};
	}>;
};
