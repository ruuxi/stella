/**
 * User Browser Detection & Lifecycle
 *
 * Detects installed Chromium-based browsers on the user's system
 * and provides graceful shutdown for relaunching with Playwright pipes.
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DetectedBrowser {
  name: string;
  executablePath: string;
  profileDir: string;
  processName: string; // Process name for shutdown (e.g., "chrome.exe", "Google Chrome")
}

interface BrowserCandidate {
  name: string;
  processName: string;
  win?: { exe: string; profile: string };
  mac?: { app: string; exe: string; profile: string };
  linux?: { exe: string; profile: string };
}

const BROWSERS: BrowserCandidate[] = [
  {
    name: 'Chrome',
    processName: 'chrome',
    win: {
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      profile: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    },
    mac: {
      app: 'Google Chrome',
      exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      profile: path.join(os.homedir(), 'Library', 'Application Support', 'Google Chrome'),
    },
    linux: {
      exe: '/usr/bin/google-chrome',
      profile: path.join(os.homedir(), '.config', 'google-chrome'),
    },
  },
  {
    name: 'Edge',
    processName: 'msedge',
    win: {
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      profile: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
    },
    mac: {
      app: 'Microsoft Edge',
      exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      profile: path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
    },
    linux: {
      exe: '/usr/bin/microsoft-edge',
      profile: path.join(os.homedir(), '.config', 'microsoft-edge'),
    },
  },
  {
    name: 'Brave',
    processName: 'brave',
    win: {
      exe: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      profile: path.join(
        process.env.LOCALAPPDATA || '',
        'BraveSoftware',
        'Brave-Browser',
        'User Data'
      ),
    },
    mac: {
      app: 'Brave Browser',
      exe: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      profile: path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'BraveSoftware',
        'Brave-Browser'
      ),
    },
    linux: {
      exe: '/usr/bin/brave-browser',
      profile: path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser'),
    },
  },
  {
    name: 'Vivaldi',
    processName: 'vivaldi',
    win: {
      exe: path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'Application', 'vivaldi.exe'),
      profile: path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'User Data'),
    },
    mac: {
      app: 'Vivaldi',
      exe: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      profile: path.join(os.homedir(), 'Library', 'Application Support', 'Vivaldi'),
    },
    linux: {
      exe: '/usr/bin/vivaldi',
      profile: path.join(os.homedir(), '.config', 'vivaldi'),
    },
  },
  {
    name: 'Arc',
    processName: 'Arc',
    mac: {
      app: 'Arc',
      exe: '/Applications/Arc.app/Contents/MacOS/Arc',
      profile: path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'User Data'),
    },
  },
];

/**
 * Detect all installed Chromium-based browsers on this system.
 */
export function detectBrowsers(): DetectedBrowser[] {
  const platform = process.platform;
  const detected: DetectedBrowser[] = [];

  for (const browser of BROWSERS) {
    let exePath: string | undefined;
    let profileDir: string | undefined;

    if (platform === 'win32' && browser.win) {
      exePath = browser.win.exe;
      profileDir = browser.win.profile;
    } else if (platform === 'darwin' && browser.mac) {
      exePath = browser.mac.exe;
      profileDir = browser.mac.profile;
    } else if (platform === 'linux' && browser.linux) {
      exePath = browser.linux.exe;
      profileDir = browser.linux.profile;
    }

    if (exePath && profileDir && existsSync(exePath)) {
      detected.push({
        name: browser.name,
        executablePath: exePath,
        profileDir,
        processName: browser.processName,
      });
    }
  }

  return detected;
}

/**
 * Detect which Chromium browser is currently running, or fall back to first installed.
 */
export function detectDefaultBrowser(): DetectedBrowser | null {
  const installed = detectBrowsers();
  if (installed.length === 0) return null;

  // Check which one is currently running
  for (const browser of installed) {
    if (isBrowserRunning(browser)) {
      return browser;
    }
  }

  // None running — return first installed
  return installed[0];
}

/**
 * Check if a browser process is currently running.
 */
function isBrowserRunning(browser: DetectedBrowser): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "IMAGENAME eq ${browser.processName}.exe" /NH`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.includes(browser.processName);
    } else {
      // macOS / Linux: use pgrep
      execSync(`pgrep -x "${browser.processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Gracefully shut down a running browser so we can relaunch it with Playwright pipes.
 * Waits up to `timeoutMs` for the process to exit.
 */
export async function gracefulShutdown(
  browser: DetectedBrowser,
  timeoutMs: number = 10000
): Promise<void> {
  if (!isBrowserRunning(browser)) return;

  console.log(`[UserBrowser] Shutting down ${browser.name}...`);

  if (process.platform === 'win32') {
    // Graceful close on Windows (no /F flag)
    try {
      execSync(`taskkill /IM ${browser.processName}.exe`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // May fail if already closing
    }
  } else if (process.platform === 'darwin') {
    // macOS: use AppleScript for graceful quit
    const candidate = BROWSERS.find((b) => b.name === browser.name);
    const appName = candidate?.mac?.app;
    if (appName) {
      try {
        execSync(`osascript -e 'tell application "${appName}" to quit'`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Fallback to SIGTERM
        try {
          execSync(`pkill -TERM "${browser.processName}"`, {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          // Already dead
        }
      }
    }
  } else {
    // Linux: SIGTERM
    try {
      execSync(`pkill -TERM "${browser.processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Already dead
    }
  }

  // Wait for the process to actually exit
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isBrowserRunning(browser)) {
      console.log(`[UserBrowser] ${browser.name} shut down successfully`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // If still running after timeout, force kill
  console.log(`[UserBrowser] ${browser.name} didn't shut down gracefully, force killing...`);
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /IM ${browser.processName}.exe`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      execSync(`pkill -9 "${browser.processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  } catch {
    // Best effort
  }

  // Wait a bit more for cleanup
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * Relaunch the user's browser with --silent-debugger-extension-api flag.
 * This suppresses the "started debugging" infobar when the extension uses chrome.debugger.
 * Returns the detected browser info.
 */
export async function relaunchForExtensionBridge(
  extraArgs: string[] = []
): Promise<DetectedBrowser> {
  const detected = detectDefaultBrowser();
  if (!detected) {
    throw new Error(
      'No Chromium browser found. Install Chrome, Edge, Brave, or another Chromium browser.'
    );
  }

  console.log(`[UserBrowser] Detected ${detected.name} at ${detected.executablePath}`);

  // Shut down existing browser
  await gracefulShutdown(detected);
  // Wait for profile lock release
  await new Promise((r) => setTimeout(r, 1500));

  // Relaunch with the silent debugger flag + load extension from source
  const extensionPath = path.resolve(__dirname, '..', 'extension');
  const args = [
    '--silent-debugger-extension-api',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    '--restore-last-session',
    `--load-extension=${extensionPath}`,
    ...extraArgs,
  ];

  console.log(`[UserBrowser] Relaunching ${detected.name} with flags:`, args);
  const child = spawn(detected.executablePath, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  // Wait for the browser to start
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (isBrowserRunning(detected)) {
      console.log(`[UserBrowser] ${detected.name} is running`);
      return detected;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`${detected.name} failed to start within 15 seconds`);
}
