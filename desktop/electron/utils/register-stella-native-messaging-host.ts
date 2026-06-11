/**
 * Registers the Stella native messaging host with Chromium-based browsers so the
 * extension can connect without manual setup (Windows registry + per-browser JSON).
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_BROWSER_EXTENSION_ID,
  STELLA_NATIVE_MESSAGING_HOST_NAME,
  getStellaBrowserSocketDir,
} from "../../../runtime/kernel/tools/stella-browser-bridge-config.js";
import { resolveStellaBrowserRoot } from "./stella-browser-paths.js";

const execFileAsync = promisify(execFile);

function getStellaBrowserBinaryName(): string | null {
  const plat = os.platform();
  const cpuArch = os.arch();

  let osKey: string;
  switch (plat) {
    case "darwin":
      osKey = "darwin";
      break;
    case "linux":
      osKey = "linux";
      break;
    case "win32":
      osKey = "win32";
      break;
    default:
      return null;
  }

  let archKey: string;
  switch (cpuArch) {
    case "x64":
      archKey = "x64";
      break;
    case "arm64":
      archKey = "arm64";
      break;
    default:
      return null;
  }

  const ext = plat === "win32" ? ".exe" : "";
  return `stella-browser-${osKey}-${archKey}${ext}`;
}

const getSocketDir = getStellaBrowserSocketDir;

function buildNativeHostManifest(
  launcherPath: string,
): Record<string, unknown> {
  return {
    name: STELLA_NATIVE_MESSAGING_HOST_NAME,
    description: "Stella browser extension bridge",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${STELLA_BROWSER_EXTENSION_ID}/`],
  };
}

function quoteForSh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function writeLauncherAndManifest(
  binaryPath: string,
  socketDir: string,
): {
  manifestPath: string;
  manifest: Record<string, unknown>;
} {
  const plat = os.platform();

  let hostPath: string;
  if (plat === "win32") {
    // Point the manifest directly at the exe. The binary recognizes Chrome's
    // spawn from the chrome-extension:// origin argument, and its default
    // session/socket-dir resolution matches the desktop's, so the old .cmd
    // env wrapper (which kept a visible cmd.exe alive for the host's whole
    // lifetime in Task Manager) is unnecessary.
    hostPath = binaryPath;
    rmSync(path.join(socketDir, "stella-native-host-launcher.cmd"), {
      force: true,
    });
  } else {
    // Bake the resolved socketDir into the launcher so the native host reads
    // discovery files from the same directory the daemon wrote them to,
    // regardless of how the directory was resolved (env override, XDG, homedir).
    const launcherPath = path.join(socketDir, "stella-native-host-launcher.sh");
    const quotedBinaryPath = quoteForSh(binaryPath);
    const quotedSocketDir = quoteForSh(socketDir);
    const body = `#!/bin/sh
export STELLA_BROWSER_NATIVE_HOST=1
export STELLA_BROWSER_SESSION=${STELLA_BROWSER_BRIDGE_SESSION}
export STELLA_BROWSER_SOCKET_DIR=${quotedSocketDir}
# Repair execute bit if stripped (e.g. Bun postinstall skips lifecycle scripts)
test -x ${quotedBinaryPath} || chmod +x ${quotedBinaryPath} 2>/dev/null
exec ${quotedBinaryPath} "$@"
`;
    writeFileSync(launcherPath, body, "utf8");
    chmodSync(launcherPath, 0o755);
    hostPath = launcherPath;
  }

  const manifest = buildNativeHostManifest(hostPath);
  const manifestPath = path.join(
    socketDir,
    `${STELLA_NATIVE_MESSAGING_HOST_NAME}.json`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { manifestPath, manifest };
}

async function installWindowsRegistry(manifestPath: string) {
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
  ];

  await Promise.allSettled(
    keys.map(async (key) => {
      try {
        await execFileAsync(
          "reg",
          ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
          { windowsHide: true },
        );
      } catch {
        // Browser may not be installed; ignore.
      }
    }),
  );
}

function installUnixSymlinks(manifest: Record<string, unknown>) {
  const homedir = os.homedir();
  const plat = os.platform();

  const dirs: string[] = [];
  if (plat === "darwin") {
    dirs.push(
      path.join(
        homedir,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      ),
      path.join(
        homedir,
        "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      ),
      path.join(
        homedir,
        "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      ),
      path.join(
        homedir,
        "Library/Application Support/Chromium/NativeMessagingHosts",
      ),
    );
  } else if (plat === "linux") {
    const cfg = path.join(homedir, ".config");
    dirs.push(
      path.join(cfg, "google-chrome/NativeMessagingHosts"),
      path.join(cfg, "microsoft-edge/NativeMessagingHosts"),
      path.join(cfg, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
      path.join(cfg, "chromium/NativeMessagingHosts"),
    );
  }

  const fileName = `${STELLA_NATIVE_MESSAGING_HOST_NAME}.json`;
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;

  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, fileName), payload, "utf8");
    } catch {
      // Best-effort per profile location.
    }
  }
}

/**
 * Idempotently writes the native host launcher, manifest, and browser registrations.
 */
export async function registerStellaNativeMessagingHost(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const binaryName = getStellaBrowserBinaryName();
    if (!binaryName) {
      return {
        ok: false,
        error:
          "Native messaging host registration is not supported on this system.",
      };
    }

    const binaryPath = path.join(resolveStellaBrowserRoot(), "bin", binaryName);
    if (!existsSync(binaryPath)) {
      return {
        ok: false,
        error:
          "Browser bridge is not installed. Reinstall Stella or run the desktop build so the bridge binary is present.",
      };
    }

    const socketDir = getSocketDir();
    mkdirSync(socketDir, { recursive: true });

    const { manifestPath, manifest } = writeLauncherAndManifest(
      binaryPath,
      socketDir,
    );

    if (os.platform() === "win32") {
      await installWindowsRegistry(manifestPath);
    } else {
      installUnixSymlinks(manifest);
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Native messaging host registration failed: ${message}`,
    };
  }
}
