import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
	chmod,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { InstallerState, SetupStepId } from "../shared/types";

/* ── Constants ───────────────────────────────────────────────────── */

const INSTALL_MANIFEST = "stella-install.json";
const PLACEHOLDER_MARKER = ".stella-placeholder";
const LAUNCH_SCRIPT_WIN = "launch.cmd";
const LAUNCH_SCRIPT_UNIX = "launch.sh";
const ESTIMATED_INSTALL_BYTES = 1024 * 1024 * 1024; // 1 GB
const APP_VERSION = "0.0.1";
const STELLA_BROWSER_GITHUB_REPO = "vercel-labs/stella-browser";

const DESKTOP_ENV_LOCAL = `VITE_CONVEX_URL=https://impartial-crab-34.convex.cloud
VITE_CONVEX_SITE_URL=https://impartial-crab-34.convex.site
VITE_SITE_URL=http://localhost:5714
VITE_TWITCH_EMOTE_TWITCH_ID=40934651
`;

/* ── Dev-mode source detection ───────────────────────────────────── */

const hasDesktopRepo = (root: string): boolean =>
	existsSync(path.join(root, "desktop", "package.json"));

const findStellaRoot = (): string => {
	const visited = new Set<string>();
	for (const seed of [process.cwd(), import.meta.dir]) {
		let cur = path.resolve(seed);
		while (!visited.has(cur)) {
			visited.add(cur);
			if (hasDesktopRepo(cur)) return cur;
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	return path.resolve(process.cwd(), "..");
};

const STELLA_ROOT = findStellaRoot();
const SOURCE_DESKTOP_DIR = hasDesktopRepo(STELLA_ROOT)
	? path.join(STELLA_ROOT, "desktop")
	: null;

/* ── Public types ────────────────────────────────────────────────── */

export type InstallerMode = "development" | "production";
export type InstallerPhase =
	| "checking"
	| "ready"
	| "installing"
	| "complete"
	| "error";

export type InstallerContext = {
	channel: string;
	mode: InstallerMode;
	defaultInstallPath: string;
	settingsFilePath: string;
	requiredBytes: number;
	sourceDesktopDir: string | null;
	stellaRoot: string;
};

export type LaunchInfo = {
	mode: InstallerMode;
	command: string[];
	cwd: string;
};

/* ── Internal types ──────────────────────────────────────────────── */

type Notifier = (state: InstallerState) => void;

type StepDef = {
	id: SetupStepId;
	label: string;
	check: (s: InstallerState, c: InstallerContext) => Promise<boolean>;
	install: (s: InstallerState, c: InstallerContext) => Promise<boolean>;
};

type Settings = {
	installPath?: string;
	runAfterInstall?: boolean;
};

type Manifest = {
	version: string;
	channel: string;
	mode: InstallerMode;
	platform: NodeJS.Platform;
	installedAt: string;
	installPath: string;
	launchScript: string;
	shortcuts: Record<string, string>;
};

/* ── Shell / FS helpers ──────────────────────────────────────────── */

const run = async (
	cmd: string[],
	opts?: { cwd?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
	try {
		const proc = Bun.spawn(cmd, {
			cwd: opts?.cwd,
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch {
		return { ok: false, stdout: "", stderr: "spawn failed" };
	}
};

const exists = async (p: string): Promise<boolean> => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

/* ── Path helpers ────────────────────────────────────────────────── */

const expandHome = (p: string): string =>
	p === "~"
		? homedir()
		: p.startsWith("~")
			? path.join(homedir(), p.slice(2))
			: p;

const norm = (p: string): string => path.resolve(expandHome(p.trim()));

const manifestOf = (d: string) => path.join(d, INSTALL_MANIFEST);
const placeholderOf = (d: string) => path.join(d, PLACEHOLDER_MARKER);
const packageJsonOf = (d: string) => path.join(d, "package.json");
const nodeModulesOf = (d: string) => path.join(d, "node_modules");
const envLocalOf = (d: string) => path.join(d, ".env.local");
const launchScriptName = () =>
	process.platform === "win32" ? LAUNCH_SCRIPT_WIN : LAUNCH_SCRIPT_UNIX;
const launchScriptOf = (d: string) => path.join(d, launchScriptName());
const stellaBrowserRootOf = (d: string) => path.join(d, "stella-browser");
const stellaBrowserWrapperOf = (d: string) =>
	path.join(stellaBrowserRootOf(d), "bin", "stella-browser.js");
const stellaBrowserCargoTomlOf = (d: string) =>
	path.join(stellaBrowserRootOf(d), "cli", "Cargo.toml");

const getStellaBrowserBinaryName = (): string | null => {
	const os =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "linux"
				? "linux"
				: process.platform === "win32"
					? "win32"
					: null;
	if (!os) return null;

	const arch =
		process.arch === "x64"
			? "x64"
			: process.arch === "arm64"
				? "arm64"
				: null;
	if (!arch) return null;

	const ext = process.platform === "win32" ? ".exe" : "";
	return `stella-browser-${os}-${arch}${ext}`;
};

const stellaBrowserBinaryOf = (d: string): string | null => {
	const binaryName = getStellaBrowserBinaryName();
	return binaryName
		? path.join(stellaBrowserRootOf(d), "bin", binaryName)
		: null;
};

const desktopDirOf = (
	state: InstallerState,
	ctx: InstallerContext,
): string | null => (ctx.mode === "development" ? ctx.sourceDesktopDir : state.installPath);

const readStellaBrowserVersion = async (desktopDir: string): Promise<string | null> => {
	try {
		const cargoToml = await readFile(stellaBrowserCargoTomlOf(desktopDir), "utf8");
		const match = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
};

const ensureExecutable = async (p: string): Promise<void> => {
	if (process.platform !== "win32") {
		await chmod(p, 0o755);
	}
};

const verifyStellaBrowserBinary = async (
	desktopDir: string,
	expectedVersion?: string | null,
): Promise<boolean> => {
	const wrapper = stellaBrowserWrapperOf(desktopDir);
	const binary = stellaBrowserBinaryOf(desktopDir);
	if (!binary) return false;
	if (!(await exists(wrapper)) || !(await exists(binary))) return false;

	await ensureExecutable(binary);

	const result = await run(["bun", "stella-browser/bin/stella-browser.js", "--version"], {
		cwd: desktopDir,
	});
	if (!result.ok) return false;
	if (expectedVersion && !result.stdout.includes(expectedVersion)) return false;
	return true;
};

const downloadStellaBrowserBinary = async (
	desktopDir: string,
	version: string,
): Promise<boolean> => {
	const binaryName = getStellaBrowserBinaryName();
	const binaryPath = stellaBrowserBinaryOf(desktopDir);
	if (!binaryName || !binaryPath) return false;

	const url = `https://github.com/${STELLA_BROWSER_GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

	try {
		const response = await fetch(url);
		if (!response.ok) return false;

		await mkdir(path.dirname(binaryPath), { recursive: true });
		const bytes = Buffer.from(await response.arrayBuffer());
		await writeFile(binaryPath, bytes);
		await ensureExecutable(binaryPath);
		return true;
	} catch {
		return false;
	}
};

const ensureStellaBrowserRuntime = async (
	state: InstallerState,
	ctx: InstallerContext,
): Promise<boolean> => {
	const desktopDir = desktopDirOf(state, ctx);
	if (!desktopDir) return false;

	const version = await readStellaBrowserVersion(desktopDir);
	if (!version) return false;

	if (await verifyStellaBrowserBinary(desktopDir, version)) {
		return true;
	}

	if (!(await downloadStellaBrowserBinary(desktopDir, version))) {
		return false;
	}

	return verifyStellaBrowserBinary(desktopDir, version);
};

/* ── Validation ──────────────────────────────────────────────────── */

const locationError = (
	p: string,
	c: InstallerContext,
): string | undefined => {
	if (!p.trim()) return "Choose where Stella should be installed.";
	if (!path.isAbsolute(p))
		return "Install location must be an absolute path.";
	const r = path.resolve(p);
	if (r === path.parse(r).root)
		return "Choose a folder, not the root of a drive.";
	if (
		c.mode === "development" &&
		r.toLowerCase().startsWith(c.stellaRoot.toLowerCase())
	)
		return "Choose a location outside the Stella source checkout.";
	return undefined;
};

/* ── Disk ────────────────────────────────────────────────────────── */

const ancestorThatExists = async (p: string): Promise<string> => {
	let c = path.resolve(p);
	while (!(await exists(c))) {
		const parent = path.dirname(c);
		if (parent === c) return c;
		c = parent;
	}
	return c;
};

const getAvailableBytes = async (p: string): Promise<number | null> => {
	try {
		if (process.platform === "win32") {
			const root = path
				.parse(path.resolve(p))
				.root.replace(/[\\/]+$/, "");
			const r = await run([
				"powershell",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${root}'"; if ($d) { $d.FreeSpace }`,
			]);
			return r.ok && r.stdout ? Number.parseInt(r.stdout, 10) : null;
		}
		const anc = await ancestorThatExists(p);
		const r = await run([
			"bash",
			"-lc",
			`df -k ${JSON.stringify(anc)} | tail -1 | awk '{print $4}'`,
		]);
		return r.ok && r.stdout ? Number.parseInt(r.stdout, 10) * 1024 : null;
	} catch {
		return null;
	}
};

const dirSize = async (p: string): Promise<number> => {
	try {
		const s = await stat(p);
		if (!s.isDirectory()) return s.size;
		const entries = await readdir(p, { withFileTypes: true });
		const sizes = await Promise.all(
			entries.map(async (e) => {
				const ep = path.join(p, e.name);
				return e.isDirectory()
					? dirSize(ep)
					: (await stat(ep).catch(() => ({ size: 0 }))).size;
			}),
		);
		return sizes.reduce((a, b) => a + b, 0);
	} catch {
		return 0;
	}
};

/* ── Settings persistence ────────────────────────────────────────── */

const readSettings = async (c: InstallerContext): Promise<Settings> => {
	try {
		return JSON.parse(await readFile(c.settingsFilePath, "utf8"));
	} catch {
		return {};
	}
};

const writeSettings = async (
	c: InstallerContext,
	s: InstallerState,
): Promise<void> => {
	await mkdir(path.dirname(c.settingsFilePath), { recursive: true });
	await writeFile(
		c.settingsFilePath,
		JSON.stringify(
			{
				installPath: s.installPath,
				runAfterInstall: s.runAfterInstall,
			},
			null,
			2,
		),
	);
};

/* ── Launch script ───────────────────────────────────────────────── */

const writeLaunchScript = async (
	installDir: string,
	workingDir?: string,
): Promise<string> => {
	const scriptPath = launchScriptOf(installDir);
	const cwd = workingDir ?? installDir;

	if (process.platform === "win32") {
		await writeFile(
			scriptPath,
			`@echo off\r\ncd /d "${cwd}"\r\nbun run electron:dev\r\n`,
		);
	} else {
		await writeFile(
			scriptPath,
			`#!/bin/sh\ncd "${cwd}"\nexec bun run electron:dev\n`,
		);
		await chmod(scriptPath, 0o755);
	}

	return scriptPath;
};

/* ── Shortcuts (Windows) ─────────────────────────────────────────── */

const desktopLnk = (): string | null =>
	process.platform === "win32"
		? path.join(homedir(), "Desktop", "Stella.lnk")
		: null;

const startMenuLnk = (): string | null =>
	process.platform === "win32"
		? path.join(
				process.env.APPDATA ||
					path.join(homedir(), "AppData", "Roaming"),
				"Microsoft",
				"Windows",
				"Start Menu",
				"Programs",
				"Stella.lnk",
			)
		: null;

const createWinLnk = async (
	lnk: string,
	target: string,
	workDir: string,
): Promise<boolean> => {
	const esc = (s: string) => s.replace(/'/g, "''");
	const ps = [
		`$w = New-Object -ComObject WScript.Shell`,
		`$s = $w.CreateShortcut('${esc(lnk)}')`,
		`$s.TargetPath = '${esc(target)}'`,
		`$s.WorkingDirectory = '${esc(workDir)}'`,
		`$s.Description = 'Stella AI Assistant'`,
		`$s.Save()`,
	].join("; ");
	return (
		await run([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			ps,
		])
	).ok;
};

const createShortcuts = async (
	installDir: string,
): Promise<Record<string, string>> => {
	const target = launchScriptOf(installDir);
	const created: Record<string, string> = {};

	if (process.platform === "win32") {
		const desk = desktopLnk();
		if (desk) {
			if (await createWinLnk(desk, target, installDir))
				created.desktop = desk;
		}
		const sm = startMenuLnk();
		if (sm) {
			await mkdir(path.dirname(sm), { recursive: true });
			if (await createWinLnk(sm, target, installDir))
				created.startMenu = sm;
		}
	}

	return created;
};

const removeShortcuts = async (): Promise<void> => {
	for (const p of [desktopLnk(), startMenuLnk()]) {
		try {
			if (p && (await exists(p))) await unlink(p);
		} catch {
			/* non-fatal */
		}
	}
};

const expectedShortcutPaths = (): Record<string, string> => {
	const out: Record<string, string> = {};
	const dl = desktopLnk();
	if (dl) out.desktop = dl;
	const sm = startMenuLnk();
	if (sm) out.startMenu = sm;
	return out;
};

/* ── Windows registry (Add / Remove Programs) ───────────────────── */

const REG_UNINSTALL =
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Stella";

const writeRegistry = async (m: Manifest): Promise<boolean> => {
	if (process.platform !== "win32") return true;

	const sizeKB = String(Math.round(ESTIMATED_INSTALL_BYTES / 1024));
	const entries: [string, string, string][] = [
		["DisplayName", "REG_SZ", "Stella"],
		["DisplayVersion", "REG_SZ", m.version],
		["Publisher", "REG_SZ", "Stella"],
		["InstallLocation", "REG_SZ", m.installPath],
		["DisplayIcon", "REG_SZ", m.launchScript],
		["UninstallString", "REG_SZ", m.launchScript], // placeholder
		["NoModify", "REG_DWORD", "1"],
		["NoRepair", "REG_DWORD", "1"],
		["EstimatedSize", "REG_DWORD", sizeKB],
	];

	for (const [name, type, data] of entries) {
		const r = await run([
			"reg",
			"add",
			REG_UNINSTALL,
			"/v",
			name,
			"/t",
			type,
			"/d",
			data,
			"/f",
		]);
		if (!r.ok) return false;
	}

	return true;
};

const removeRegistry = async (): Promise<void> => {
	if (process.platform !== "win32") return;
	await run(["reg", "delete", REG_UNINSTALL, "/f"]);
};

/* ── Step definitions ────────────────────────────────────────────── */

const BUN_INSTALL_URL_WIN = "https://bun.sh/install.ps1";
const BUN_INSTALL_URL_UNIX = "https://bun.sh/install";

const bunOnPath = async (): Promise<boolean> => {
	const result = await run(["bun", "--version"]);
	return result.ok;
};

const installBunGlobally = async (): Promise<boolean> => {
	if (process.platform === "win32") {
		const result = await run([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`irm ${BUN_INSTALL_URL_WIN} | iex`,
		]);
		if (!result.ok) return false;
	} else {
		const result = await run([
			"bash",
			"-lc",
			`curl -fsSL ${BUN_INSTALL_URL_UNIX} | bash`,
		]);
		if (!result.ok) return false;
	}

	// Verify bun is now reachable. The installer adds to PATH but the
	// current process may not reflect it yet — check the well-known
	// install location and prepend it to PATH if needed.
	if (await bunOnPath()) return true;

	const bunBin =
		process.platform === "win32"
			? path.join(homedir(), ".bun", "bin", "bun.exe")
			: path.join(homedir(), ".bun", "bin", "bun");

	if (await exists(bunBin)) {
		const binDir = path.dirname(bunBin);
		process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
		return bunOnPath();
	}

	return false;
};

const buildSteps = (ctx: InstallerContext): StepDef[] => {
	const steps: StepDef[] = [
		{
			id: "runtime",
			label: "Checking system requirements",
			check: async () => bunOnPath(),
			install: async () => installBunGlobally(),
		},
		{
			id: "prepare",
			label: "Preparing install location",
			check: (s) => exists(s.installPath),
			install: async (s) => {
				await mkdir(s.installPath, { recursive: true });
				return true;
			},
		},
	];

	if (ctx.mode === "development" && ctx.sourceDesktopDir) {
		// Dev: ensure desktop repo dependencies are installed.
		steps.push({
			id: "deps",
			label: "Setting up development runtime",
			check: async () =>
				exists(path.join(ctx.sourceDesktopDir!, "node_modules")),
			install: async () =>
				(await run(["bun", "install"], { cwd: ctx.sourceDesktopDir! }))
					.ok,
		});
		steps.push({
			id: "env",
			label: "Configuring environment",
			check: async () => exists(envLocalOf(ctx.sourceDesktopDir!)),
			install: async () => {
				await writeFile(envLocalOf(ctx.sourceDesktopDir!), DESKTOP_ENV_LOCAL);
				return true;
			},
		});
		steps.push({
			id: "browser",
			label: "Provisioning Stella Browser",
			check: async (s) => {
				const desktopDir = desktopDirOf(s, ctx);
				if (!desktopDir) return false;
				if (!(await exists(stellaBrowserWrapperOf(desktopDir)))) return true;
				return verifyStellaBrowserBinary(
					desktopDir,
					await readStellaBrowserVersion(desktopDir),
				);
			},
			install: async (s) => {
				const desktopDir = desktopDirOf(s, ctx);
				if (!desktopDir) return false;
				if (!(await exists(stellaBrowserWrapperOf(desktopDir)))) return true;
				return ensureStellaBrowserRuntime(s, ctx);
			},
		});
	} else {
		// Production: download/extract the Stella repo.
		steps.push({
			id: "payload",
			label: "Installing Stella",
			check: (s) => exists(packageJsonOf(s.installPath)),
			install: async (s) => {
				// ┌──────────────────────────────────────────────────────┐
				// │  PLACEHOLDER — replace with real zip download and    │
				// │  extraction once the desktop repo is packaged for    │
				// │  distribution. After this step, installPath should   │
				// │  contain the full extracted repo (package.json, etc) │
				// └──────────────────────────────────────────────────────┘
				await mkdir(s.installPath, { recursive: true });
				await writeFile(
					placeholderOf(s.installPath),
					JSON.stringify(
						{
							placeholder: true,
							note: "Repo download not yet wired. Replace this step with real zip download + extraction.",
							createdAt: new Date().toISOString(),
						},
						null,
						2,
					),
				);
				return true;
			},
		});

		// Production: install dependencies in the extracted repo.
		steps.push({
			id: "deps",
			label: "Installing dependencies",
			check: (s) => exists(nodeModulesOf(s.installPath)),
			install: async (s) => {
				// Skip gracefully if the repo isn't extracted yet (placeholder payload).
				if (!(await exists(packageJsonOf(s.installPath)))) return true;
				return (
					await run(["bun", "install"], { cwd: s.installPath })
				).ok;
			},
		});
		steps.push({
			id: "env",
			label: "Configuring environment",
			check: (s) => exists(envLocalOf(s.installPath)),
			install: async (s) => {
				await writeFile(envLocalOf(s.installPath), DESKTOP_ENV_LOCAL);
				return true;
			},
		});
		steps.push({
			id: "browser",
			label: "Provisioning Stella Browser",
			check: async (s) => {
				const desktopDir = desktopDirOf(s, ctx);
				if (!desktopDir) return false;
				return verifyStellaBrowserBinary(
					desktopDir,
					await readStellaBrowserVersion(desktopDir),
				);
			},
			install: async (s) => ensureStellaBrowserRuntime(s, ctx),
		});

		// Shortcuts only for production installs (Windows for now).
		if (process.platform === "win32") {
			steps.push({
				id: "shortcuts",
				label: "Creating shortcuts",
				check: async () => {
					const dl = desktopLnk();
					return dl != null && (await exists(dl));
				},
				install: async (s) => {
					await writeLaunchScript(s.installPath);
					await createShortcuts(s.installPath);
					return true;
				},
			});
		}
	}

	steps.push({
		id: "finalize",
		label: "Finishing up",
		check: (s) => exists(manifestOf(s.installPath)),
		install: async (s) => {
			const scriptPath = await writeLaunchScript(
				s.installPath,
				ctx.mode === "development" ? ctx.sourceDesktopDir ?? undefined : undefined,
			);

			const manifest: Manifest = {
				version: APP_VERSION,
				channel: ctx.channel,
				mode: ctx.mode,
				platform: process.platform,
				installedAt: new Date().toISOString(),
				installPath: s.installPath,
				launchScript: scriptPath,
				shortcuts:
					ctx.mode === "production" ? expectedShortcutPaths() : {},
			};

			await writeFile(
				manifestOf(s.installPath),
				JSON.stringify(manifest, null, 2),
			);

			// Register with Add/Remove Programs on Windows (production only).
			if (ctx.mode === "production") {
				await writeRegistry(manifest);
			}

			return true;
		},
	});

	return steps;
};

/* ── State sync helpers ──────────────────────────────────────────── */

const syncStepList = (
	state: InstallerState,
	ctx: InstallerContext,
): StepDef[] => {
	const defs = buildSteps(ctx);
	state.steps = defs.map((d) => {
		const prev = state.steps.find((s) => s.id === d.id);
		return prev ?? { id: d.id, label: d.label, status: "pending" };
	});
	return defs;
};

const refreshDerived = async (
	state: InstallerState,
	ctx: InstallerContext,
): Promise<void> => {
	const used = await dirSize(state.installPath);
	const avail = await getAvailableBytes(state.installPath);
	const remaining = Math.max(ctx.requiredBytes - used, 0);

	state.disk = {
		requiredBytes: ctx.requiredBytes,
		availableBytes: avail,
		usedBytes: used,
		enoughSpace: avail == null ? true : avail >= remaining,
	};
	state.installPathError = locationError(state.installPath, ctx);

	if (ctx.mode === "development") {
		const desktopDir = ctx.sourceDesktopDir;
		state.canLaunch =
			desktopDir != null &&
			(await exists(nodeModulesOf(desktopDir))) &&
			(await verifyStellaBrowserBinary(
				desktopDir,
				await readStellaBrowserVersion(desktopDir),
			));
	} else {
		const hasRepo = await exists(packageJsonOf(state.installPath));
		const hasDeps = await exists(nodeModulesOf(state.installPath));
		state.canLaunch =
			hasRepo &&
			hasDeps &&
			(await verifyStellaBrowserBinary(
				state.installPath,
				await readStellaBrowserVersion(state.installPath),
			));
	}
};

const emitState = async (
	state: InstallerState,
	ctx: InstallerContext,
	fn: Notifier,
): Promise<void> => {
	await refreshDerived(state, ctx);
	fn(state);
};

/* ── Public API ──────────────────────────────────────────────────── */

export const createSetupContext = (opts: {
	channel: string;
	defaultInstallPath: string;
	settingsFilePath: string;
	requiredBytes?: number;
}): InstallerContext => ({
	channel: opts.channel,
	mode: opts.channel === "dev" ? "development" : "production",
	defaultInstallPath: opts.defaultInstallPath,
	settingsFilePath: opts.settingsFilePath,
	requiredBytes: opts.requiredBytes ?? ESTIMATED_INSTALL_BYTES,
	sourceDesktopDir: SOURCE_DESKTOP_DIR,
	stellaRoot: STELLA_ROOT,
});

export const createSetupState = async (
	ctx: InstallerContext,
): Promise<InstallerState> => {
	const settings = await readSettings(ctx);
	const state: InstallerState = {
		steps: [],
		phase: "checking",
		mode: ctx.mode,
		installPath: norm(settings.installPath || ctx.defaultInstallPath),
		defaultInstallPath: ctx.defaultInstallPath,
		runAfterInstall: settings.runAfterInstall ?? true,
		canLaunch: false,
		installed: false,
		disk: {
			requiredBytes: ctx.requiredBytes,
			availableBytes: null,
			usedBytes: 0,
			enoughSpace: true,
		},
	};
	await refreshDerived(state, ctx);
	syncStepList(state, ctx);
	return state;
};

export const setInstallPath = async (
	state: InstallerState,
	ctx: InstallerContext,
	installPath: string,
): Promise<void> => {
	state.installPath = norm(installPath);
	state.errorMessage = undefined;
	await writeSettings(ctx, state);
};

export const setRunAfterInstall = async (
	state: InstallerState,
	ctx: InstallerContext,
	value: boolean,
): Promise<void> => {
	state.runAfterInstall = value;
	await writeSettings(ctx, state);
};

export const checkAll = async (
	state: InstallerState,
	ctx: InstallerContext,
	onUpdate: Notifier,
): Promise<{ allDone: boolean }> => {
	state.phase = "checking";
	state.errorMessage = undefined;
	const defs = syncStepList(state, ctx);
	await emitState(state, ctx, onUpdate);

	let allDone = true;

	for (const def of defs) {
		const step = state.steps.find((s) => s.id === def.id)!;
		step.status = "checking";
		step.detail = "Checking...";
		await emitState(state, ctx, onUpdate);

		const ok = await def.check(state, ctx);
		step.status = ok ? "skipped" : "pending";
		step.detail = ok ? "Already done" : undefined;
		await emitState(state, ctx, onUpdate);

		if (!ok) allDone = false;
	}

	state.installed = allDone;
	state.phase = allDone ? "complete" : "ready";
	await emitState(state, ctx, onUpdate);

	return { allDone };
};

export const installAll = async (
	state: InstallerState,
	ctx: InstallerContext,
	onUpdate: Notifier,
): Promise<{ ok: boolean; errorMessage?: string }> => {
	await refreshDerived(state, ctx);

	if (state.installPathError) {
		state.phase = "error";
		state.errorMessage = state.installPathError;
		await emitState(state, ctx, onUpdate);
		return { ok: false, errorMessage: state.installPathError };
	}

	if (!state.disk.enoughSpace) {
		const msg = "Not enough free disk space for this installation.";
		state.phase = "error";
		state.errorMessage = msg;
		await emitState(state, ctx, onUpdate);
		return { ok: false, errorMessage: msg };
	}

	const defs = syncStepList(state, ctx);
	state.phase = "installing";
	state.errorMessage = undefined;
	await emitState(state, ctx, onUpdate);

	for (const def of defs) {
		const step = state.steps.find((s) => s.id === def.id)!;
		if (step.status === "skipped" || step.status === "done") continue;

		step.status = "installing";
		step.detail = `${step.label}...`;
		await emitState(state, ctx, onUpdate);

		const ok = await def.install(state, ctx);
		if (!ok) {
			step.status = "error";
			step.detail = `Could not complete: ${step.label.toLowerCase()}.`;
			state.phase = "error";
			state.errorMessage = step.detail;
			await emitState(state, ctx, onUpdate);
			return { ok: false, errorMessage: state.errorMessage };
		}

		step.status = "done";
		step.detail = "Done";
		await emitState(state, ctx, onUpdate);
	}

	state.installed = true;
	state.phase = "complete";
	await writeSettings(ctx, state);
	await emitState(state, ctx, onUpdate);

	return { ok: true };
};

export const getLaunchInfo = async (
	state: InstallerState,
	ctx: InstallerContext,
): Promise<LaunchInfo | null> => {
	if (ctx.mode === "development" && ctx.sourceDesktopDir) {
		if (
			!(await verifyStellaBrowserBinary(
				ctx.sourceDesktopDir,
				await readStellaBrowserVersion(ctx.sourceDesktopDir),
			))
		) {
			return null;
		}
		return {
			mode: "development",
			command: ["bun", "run", "electron:dev"],
			cwd: ctx.sourceDesktopDir,
		};
	}

	const hasRepo = await exists(packageJsonOf(state.installPath));
	const hasDeps = await exists(nodeModulesOf(state.installPath));
	if (
		!hasRepo ||
		!hasDeps ||
		!(await verifyStellaBrowserBinary(
			state.installPath,
			await readStellaBrowserVersion(state.installPath),
		))
	)
		return null;

	return {
		mode: "production",
		command: ["bun", "run", "electron:dev"],
		cwd: state.installPath,
	};
};

export const uninstall = async (
	state: InstallerState,
	ctx: InstallerContext,
): Promise<{ ok: boolean }> => {
	try {
		await removeShortcuts();
		await removeRegistry();

		if (await exists(state.installPath)) {
			await rm(state.installPath, { recursive: true, force: true });
		}

		state.installed = false;
		state.phase = "ready";
		state.steps = [];
		syncStepList(state, ctx);

		return { ok: true };
	} catch {
		return { ok: false };
	}
};
