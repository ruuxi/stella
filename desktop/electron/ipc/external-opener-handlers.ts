/**
 * IPC handlers for opening file artifacts in external apps.
 *
 * Surfaces a curated list of app openers tailored to the file
 * extension (code editors for code, Keynote/PowerPoint for slides,
 * etc.), the OS-default opener, and a "Reveal in Finder/Explorer"
 * action. The catalog is filtered to apps actually installed on the
 * user's machine so the menu never lists something that can't run.
 */

import { ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExternalLinkService } from "../services/external-link-service.js";
import {
  AUDIO_EXTS,
  BROWSER_EXTS,
  CODE_EXTS,
  DOC_EXTS,
  HTML_EXTS,
  IMAGE_EXTS,
  PDF_EXTS,
  SHEET_EXTS,
  SLIDE_EXTS,
  VIDEO_EXTS,
  extOf,
  type ExternalOpener,
} from "../../src/shared/contracts/external-openers.js";
import {
  IPC_SHELL_LIST_OPENERS,
  IPC_SHELL_OPEN_PATH,
  IPC_SHELL_OPEN_WITH,
} from "../../src/shared/contracts/ipc-channels.js";

type MacAppDef = {
  id: string;
  label: string;
  /** App bundle name without the trailing `.app` */
  appName: string;
  /** Extensions this app should appear for (lowercase, no leading dot). */
  extensions: string[];
};

const MAC_APP_CATALOG: MacAppDef[] = [
  // Image / PDF viewers
  {
    id: "preview",
    label: "Preview",
    appName: "Preview",
    extensions: [...PDF_EXTS, ...IMAGE_EXTS],
  },
  {
    id: "colorsync",
    label: "ColorSync Utility",
    appName: "ColorSync Utility",
    extensions: IMAGE_EXTS,
  },
  {
    id: "pixelmator",
    label: "Pixelmator Pro",
    appName: "Pixelmator Pro",
    extensions: IMAGE_EXTS,
  },
  {
    id: "affinityPhoto",
    label: "Affinity Photo",
    appName: "Affinity Photo 2",
    extensions: IMAGE_EXTS,
  },
  {
    id: "acrobat",
    label: "Adobe Acrobat Reader",
    appName: "Adobe Acrobat Reader",
    extensions: PDF_EXTS,
  },

  // Browsers (good for images, PDFs, HTML, SVG)
  {
    id: "safari",
    label: "Safari",
    appName: "Safari",
    extensions: BROWSER_EXTS,
  },
  {
    id: "chrome",
    label: "Google Chrome",
    appName: "Google Chrome",
    extensions: BROWSER_EXTS,
  },
  {
    id: "brave",
    label: "Brave Browser",
    appName: "Brave Browser",
    extensions: BROWSER_EXTS,
  },
  { id: "arc", label: "Arc", appName: "Arc", extensions: BROWSER_EXTS },
  {
    id: "firefox",
    label: "Firefox",
    appName: "Firefox",
    extensions: BROWSER_EXTS,
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    appName: "Microsoft Edge",
    extensions: BROWSER_EXTS,
  },
  { id: "dia", label: "Dia", appName: "Dia", extensions: BROWSER_EXTS },

  // Media players
  {
    id: "quicktime",
    label: "QuickTime Player",
    appName: "QuickTime Player",
    extensions: [...VIDEO_EXTS, ...AUDIO_EXTS],
  },
  {
    id: "vlc",
    label: "VLC",
    appName: "VLC",
    extensions: [...VIDEO_EXTS, ...AUDIO_EXTS],
  },
  { id: "iina", label: "IINA", appName: "IINA", extensions: VIDEO_EXTS },
  {
    id: "music",
    label: "Music",
    appName: "Music",
    extensions: AUDIO_EXTS,
  },

  // Code editors
  { id: "cursor", label: "Cursor", appName: "Cursor", extensions: CODE_EXTS },
  {
    id: "vscode",
    label: "VS Code",
    appName: "Visual Studio Code",
    extensions: CODE_EXTS,
  },
  { id: "zed", label: "Zed", appName: "Zed", extensions: CODE_EXTS },
  {
    id: "sublime",
    label: "Sublime Text",
    appName: "Sublime Text",
    extensions: CODE_EXTS,
  },
  { id: "nova", label: "Nova", appName: "Nova", extensions: CODE_EXTS },
  { id: "xcode", label: "Xcode", appName: "Xcode", extensions: CODE_EXTS },
  {
    id: "textedit",
    label: "TextEdit",
    appName: "TextEdit",
    extensions: [...CODE_EXTS, ...DOC_EXTS],
  },

  // Slides / docs / sheets
  {
    id: "keynote",
    label: "Keynote",
    appName: "Keynote",
    extensions: SLIDE_EXTS,
  },
  {
    id: "powerpoint",
    label: "PowerPoint",
    appName: "Microsoft PowerPoint",
    extensions: SLIDE_EXTS,
  },
  { id: "pages", label: "Pages", appName: "Pages", extensions: DOC_EXTS },
  {
    id: "word",
    label: "Word",
    appName: "Microsoft Word",
    extensions: DOC_EXTS,
  },
  {
    id: "numbers",
    label: "Numbers",
    appName: "Numbers",
    extensions: SHEET_EXTS,
  },
  {
    id: "excel",
    label: "Excel",
    appName: "Microsoft Excel",
    extensions: SHEET_EXTS,
  },
];

// Silence unused-import warning when only some ext groups feed the
// catalog above (helps when iterating on the list).
void HTML_EXTS;

const macAppById = new Map(MAC_APP_CATALOG.map((entry) => [entry.id, entry]));

const APP_SEARCH_DIRS = (): string[] => [
  "/Applications",
  "/System/Applications",
  path.join(os.homedir(), "Applications"),
];

const appAvailabilityCache = new Map<string, boolean>();

const isMacAppInstalled = (appName: string): boolean => {
  const cached = appAvailabilityCache.get(appName);
  if (cached !== undefined) return cached;
  const bundle = `${appName}.app`;
  for (const dir of APP_SEARCH_DIRS()) {
    if (existsSync(path.join(dir, bundle))) {
      appAvailabilityCache.set(appName, true);
      return true;
    }
  }
  appAvailabilityCache.set(appName, false);
  return false;
};

const listMacOpenersForExt = (ext: string): ExternalOpener[] => {
  return MAC_APP_CATALOG.filter(
    (entry) => entry.extensions.includes(ext) && isMacAppInstalled(entry.appName),
  ).map<ExternalOpener>((entry) => ({
    id: entry.id,
    label: entry.label,
    kind: "app",
  }));
};

const buildOpenersForFile = (filePath: string): ExternalOpener[] => {
  const ext = extOf(filePath);
  const openers: ExternalOpener[] = [];
  if (process.platform === "darwin") {
    openers.push(...listMacOpenersForExt(ext));
  }
  // The OS-default opener and reveal-in-folder are always last, in that
  // order. They mirror the macOS Finder right-click "Open" + "Show in
  // Finder" layout that the menu visually borrows from.
  openers.push({ id: "__default", label: "Default app", kind: "default" });
  openers.push({
    id: "__reveal",
    label: process.platform === "win32" ? "Show in Explorer" : "Open in folder",
    kind: "reveal",
  });
  return openers;
};

const openWithMacApp = (appName: string, filePath: string) =>
  new Promise<{ ok: boolean; error?: string }>((resolve) => {
    execFile("open", ["-a", appName, filePath], (error) => {
      if (error) {
        resolve({ ok: false, error: error.message });
      } else {
        resolve({ ok: true });
      }
    });
  });

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const registerExternalOpenerHandlers = (options: {
  externalLinkService: ExternalLinkService;
}) => {
  ipcMain.handle(
    IPC_SHELL_LIST_OPENERS,
    (event, payload: { filePath?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SHELL_LIST_OPENERS,
        )
      ) {
        return { openers: [] as ExternalOpener[] };
      }
      const filePath = asTrimmedString(payload?.filePath);
      if (!filePath) {
        return { openers: [] as ExternalOpener[] };
      }
      return { openers: buildOpenersForFile(filePath) };
    },
  );

  ipcMain.handle(
    IPC_SHELL_OPEN_WITH,
    async (
      event,
      payload: { filePath?: string; openerId?: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SHELL_OPEN_WITH,
        )
      ) {
        return { ok: false, error: "Blocked untrusted request." };
      }
      const filePath = asTrimmedString(payload?.filePath);
      const openerId = asTrimmedString(payload?.openerId);
      if (!filePath || !openerId) {
        return { ok: false, error: "Missing file path or opener id." };
      }
      if (openerId === "__default") {
        const error = await shell.openPath(filePath);
        return error ? { ok: false, error } : { ok: true };
      }
      if (openerId === "__reveal") {
        shell.showItemInFolder(filePath);
        return { ok: true };
      }
      if (process.platform === "darwin") {
        const app = macAppById.get(openerId);
        if (!app) {
          return { ok: false, error: "Unknown opener." };
        }
        return await openWithMacApp(app.appName, filePath);
      }
      return { ok: false, error: "External openers are macOS-only for now." };
    },
  );

  ipcMain.handle(
    IPC_SHELL_OPEN_PATH,
    async (
      event,
      payload: { filePath?: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SHELL_OPEN_PATH,
        )
      ) {
        return { ok: false, error: "Blocked untrusted request." };
      }
      const filePath = asTrimmedString(payload?.filePath);
      if (!filePath) return { ok: false, error: "Missing file path." };
      const error = await shell.openPath(filePath);
      return error ? { ok: false, error } : { ok: true };
    },
  );
};
