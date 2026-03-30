/**
 * Registers the Stella native messaging host with Chromium-based browsers so the
 * extension can connect without manual setup (Windows registry + per-browser JSON).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_BROWSER_EXTENSION_ID,
  STELLA_NATIVE_MESSAGING_HOST_NAME,
  getStellaBrowserSocketDir,
} from "../../packages/runtime-kernel/tools/stella-browser-bridge-config.js";

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

function buildNativeHostManifest(launcherPath: string): Record<string, unknown> {
  return {
    name: STELLA_NATIVE_MESSAGING_HOST_NAME,
    description: "Stella browser extension bridge",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${STELLA_BROWSER_EXTENSION_ID}/`],
  };
}

function escapeForCmdLiteral(value: string): string {
  return value.replace(/%/g, "%%").replace(/"/g, '""');
}

function quoteForSh(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function writeLauncherAndManifest(
  binaryPath: string,
  socketDir: string,
): { launcherPath: string; manifestPath: string; manifest: Record<string, unknown> } {
  const plat = os.platform();
  const launcherPath =
    plat === "win32"
      ? path.join(socketDir, "stella-native-host-launcher.cmd")
      : path.join(socketDir, "stella-native-host-launcher.sh");

  // Always bake the resolved socketDir into the launcher so the native host
  // reads discovery files from the same directory the daemon wrote them to,
  // regardless of how the directory was resolved (env override, XDG, homedir).
  if (plat === "win32") {
    const escapedBinaryPath = escapeForCmdLiteral(binaryPath);
    const escapedSocketDir = escapeForCmdLiteral(socketDir);
    const body = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'set "STELLA_BROWSER_NATIVE_HOST=1"',
      `set "STELLA_BROWSER_SESSION=${STELLA_BROWSER_BRIDGE_SESSION}"`,
      `set "STELLA_BROWSER_SOCKET_DIR=${escapedSocketDir}"`,
      `"${escapedBinaryPath}" %*`,
      "",
    ].join("\r\n");
    writeFileSync(launcherPath, body, "utf8");
  } else {
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
  }

  const manifest = buildNativeHostManifest(launcherPath);
  const manifestPath = path.join(socketDir, `${STELLA_NATIVE_MESSAGING_HOST_NAME}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { launcherPath, manifestPath, manifest };
}

function installWindowsRegistry(manifestPath: string) {
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${STELLA_NATIVE_MESSAGING_HOST_NAME}`,
  ];

  for (const key of keys) {
    try {
      execFileSync(
        "reg",
        ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      // Browser may not be installed; ignore.
    }
  }
}

function installUnixSymlinks(manifest: Record<string, unknown>) {
  const homedir = os.homedir();
  const plat = os.platform();

  const dirs: string[] = [];
  if (plat === "darwin") {
    dirs.push(
      path.join(homedir, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
      path.join(
        homedir,
        "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      ),
      path.join(
        homedir,
        "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      ),
      path.join(homedir, "Library/Application Support/Chromium/NativeMessagingHosts"),
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
export function registerStellaNativeMessagingHost(frontendRoot: string): {
  ok: boolean;
  error?: string;
} {
  try {
    const binaryName = getStellaBrowserBinaryName();
    if (!binaryName) {
      return {
        ok: false,
        error: "Native messaging host registration is not supported on this system.",
      };
    }

    const binaryPath = path.join(frontendRoot, "stella-browser", "bin", binaryName);
    if (!existsSync(binaryPath)) {
      return {
        ok: false,
        error:
          "Browser bridge is not installed. Reinstall Stella or run the desktop build so the bridge binary is present.",
      };
    }

    const socketDir = getSocketDir();
    mkdirSync(socketDir, { recursive: true });

    const { manifestPath, manifest } = writeLauncherAndManifest(binaryPath, socketDir);

    if (os.platform() === "win32") {
      installWindowsRegistry(manifestPath);
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
