import { promises as fs } from "fs";
import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import path from "path";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "../../../runtime/kernel/home/private-fs.js";
import type { WindowManagerTarget } from "../../../runtime/kernel/lifecycle-targets.js";

const SECURITY_POLICY_VERSION = 2;
const SECURITY_APPROVAL_PREFIX = "v1:";

type PersistedSecurityPolicy = {
  approved?: unknown;
  computerUseAppApprovals?: unknown;
};

export type ComputerUseAppApprovalRequest = {
  bundleIdentifier: string;
  displayName: string;
  risk?: string;
  warningSubtitle?: string;
  allowPersistentApproval: boolean;
};

export type ComputerUseAppApprovalResult =
  | { decision: "approved"; scope: "session" | "persistent" }
  | { decision: "declined"; scope: "none" };

const canonicalBundleIdentifier = (bundleIdentifier: string) => {
  const canonical = bundleIdentifier.trim().toLowerCase();
  if (!canonical) {
    throw new TypeError(
      "Computer Use app approval requires a bundle identifier.",
    );
  }
  return canonical;
};

export class SecurityPolicyService {
  private securityPolicyPath: string | null = null;
  private readonly trustedPrivilegedActions = new Set<string>();
  private readonly sessionComputerUseAppApprovals = new Set<string>();
  private readonly persistentComputerUseAppApprovals = new Set<string>();

  constructor(
    private readonly options: {
      windowManagerTarget: WindowManagerTarget<BrowserWindow>;
    },
  ) {}

  setSecurityPolicyPath(policyPath: string) {
    this.securityPolicyPath = policyPath;
  }

  async loadPolicy() {
    this.clearAll();
    if (!this.securityPolicyPath) return;
    try {
      const raw = await fs.readFile(this.securityPolicyPath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedSecurityPolicy;
      const approved = Array.isArray(parsed?.approved) ? parsed.approved : [];
      for (const entry of approved) {
        if (
          typeof entry === "string" &&
          entry.startsWith(SECURITY_APPROVAL_PREFIX)
        ) {
          this.trustedPrivilegedActions.add(entry);
        }
      }

      const appApprovals = parsed?.computerUseAppApprovals;
      if (Array.isArray(appApprovals)) {
        for (const entry of appApprovals) {
          if (typeof entry === "string" && entry.trim()) {
            this.persistentComputerUseAppApprovals.add(
              canonicalBundleIdentifier(entry),
            );
          }
        }
      } else if (appApprovals && typeof appApprovals === "object") {
        for (const [bundleIdentifier, approval] of Object.entries(
          appApprovals,
        )) {
          const isApproved =
            approval === true ||
            (approval !== null &&
              typeof approval === "object" &&
              (approval as { approved?: unknown }).approved === true);
          if (isApproved && bundleIdentifier.trim()) {
            this.persistentComputerUseAppApprovals.add(
              canonicalBundleIdentifier(bundleIdentifier),
            );
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        console.debug(
          "[security-policy] No persisted policy yet, treating as no approvals",
        );
        return;
      }
      console.debug(
        "[security-policy] Policy file invalid, treating as no approvals:",
        err,
      );
    }
  }

  private async persistPolicy() {
    if (!this.securityPolicyPath) return;
    try {
      await ensurePrivateDir(path.dirname(this.securityPolicyPath));
      await writePrivateFile(
        this.securityPolicyPath,
        JSON.stringify(
          {
            version: SECURITY_POLICY_VERSION,
            approved: [...this.trustedPrivilegedActions].sort(),
            computerUseAppApprovals: Object.fromEntries(
              [...this.persistentComputerUseAppApprovals]
                .sort()
                .map((bundleIdentifier) => [bundleIdentifier, true]),
            ),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.debug(
        "[security-policy] Failed to persist policy (best-effort):",
        err,
      );
    }
  }

  async ensureApproval(
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) {
    const key = `${SECURITY_APPROVAL_PREFIX}${action}`;
    if (this.trustedPrivilegedActions.has(key)) {
      return true;
    }

    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const ownerWindow =
      (event ? BrowserWindow.fromWebContents(event.sender) : null) ??
      BrowserWindow.getFocusedWindow() ??
      windowManager?.getFullWindow() ??
      undefined;

    const dialogOptions: MessageBoxOptions = {
      type: "warning",
      title: "Stella Security Confirmation",
      message,
      detail,
      buttons: ["Allow", "Deny"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: "Remember this decision on this device",
      checkboxChecked: true,
    };

    const choice = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

    if (choice.response !== 0) {
      return false;
    }

    if (choice.checkboxChecked) {
      this.trustedPrivilegedActions.add(key);
      await this.persistPolicy();
    }

    return true;
  }

  async ensureComputerUseAppApproval(
    request: ComputerUseAppApprovalRequest,
  ): Promise<ComputerUseAppApprovalResult> {
    const bundleIdentifier = canonicalBundleIdentifier(
      request.bundleIdentifier,
    );
    if (this.persistentComputerUseAppApprovals.has(bundleIdentifier)) {
      return { decision: "approved", scope: "persistent" };
    }
    if (this.sessionComputerUseAppApprovals.has(bundleIdentifier)) {
      return { decision: "approved", scope: "session" };
    }

    const displayName =
      request.displayName.trim() || request.bundleIdentifier.trim();
    const warningSubtitle = request.warningSubtitle?.trim();
    const risk = request.risk?.trim();
    const detail =
      [warningSubtitle, risk ? `Risk: ${risk}` : undefined]
        .filter(Boolean)
        .join("\n\n") ||
      `Computer Use will be able to view and interact with ${displayName}.`;
    const dialogOptions: MessageBoxOptions = {
      type: "warning",
      title: "Stella Security Confirmation",
      message: `Allow Computer Use to use ${displayName}?`,
      detail,
      buttons: ["Allow", "Deny"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      ...(request.allowPersistentApproval
        ? {
            checkboxLabel: "Remember this decision on this device",
            checkboxChecked: true,
          }
        : {}),
    };

    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const ownerWindow =
      BrowserWindow.getFocusedWindow() ??
      windowManager?.getFullWindow() ??
      undefined;
    const choice = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

    if (choice.response !== 0) {
      return { decision: "declined", scope: "none" };
    }

    if (request.allowPersistentApproval && choice.checkboxChecked) {
      this.persistentComputerUseAppApprovals.add(bundleIdentifier);
      await this.persistPolicy();
      return { decision: "approved", scope: "persistent" };
    }

    this.sessionComputerUseAppApprovals.add(bundleIdentifier);
    return { decision: "approved", scope: "session" };
  }

  clearAll() {
    this.trustedPrivilegedActions.clear();
    this.sessionComputerUseAppApprovals.clear();
    this.persistentComputerUseAppApprovals.clear();
  }
}
