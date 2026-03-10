import { promises as fs } from 'fs'
import { BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent, type MessageBoxOptions } from 'electron'
import path from 'path'
import type { WindowManager } from '../windows/window-manager.js'
import { ensurePrivateDir, writePrivateFile } from '../system/private-fs.js'

const SECURITY_POLICY_VERSION = 1
const SECURITY_APPROVAL_PREFIX = `v${SECURITY_POLICY_VERSION}:`

export class SecurityPolicyService {
  private securityPolicyPath: string | null = null
  private readonly trustedPrivilegedActions = new Set<string>()
  private getWindowManager: () => WindowManager | null

  constructor(options: { getWindowManager: () => WindowManager | null }) {
    this.getWindowManager = options.getWindowManager
  }

  setSecurityPolicyPath(policyPath: string) {
    this.securityPolicyPath = policyPath
  }

  async loadPolicy() {
    if (!this.securityPolicyPath) return
    try {
      const raw = await fs.readFile(this.securityPolicyPath, 'utf-8')
      const parsed = JSON.parse(raw) as { approved?: unknown }
      const approved = Array.isArray(parsed?.approved) ? parsed.approved : []
      this.trustedPrivilegedActions.clear()
      for (const entry of approved) {
        if (typeof entry === 'string' && entry.startsWith(SECURITY_APPROVAL_PREFIX)) {
          this.trustedPrivilegedActions.add(entry)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        console.debug('[security-policy] No persisted policy yet, treating as no approvals')
        return
      }
      console.debug('[security-policy] Policy file invalid, treating as no approvals:', err)
    }
  }

  private async persistPolicy() {
    if (!this.securityPolicyPath) return
    try {
      await ensurePrivateDir(path.dirname(this.securityPolicyPath))
      await writePrivateFile(
        this.securityPolicyPath,
        JSON.stringify(
          {
            version: SECURITY_POLICY_VERSION,
            approved: [...this.trustedPrivilegedActions].sort(),
          },
          null,
          2,
        ),
      )
    } catch (err) {
      console.debug('[security-policy] Failed to persist policy (best-effort):', err)
    }
  }

  async ensureApproval(
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) {
    const key = `${SECURITY_APPROVAL_PREFIX}${action}`
    if (this.trustedPrivilegedActions.has(key)) {
      return true
    }

    const windowManager = this.getWindowManager()
    const ownerWindow =
      (event ? BrowserWindow.fromWebContents(event.sender) : null) ??
      BrowserWindow.getFocusedWindow() ??
      windowManager?.getFullWindow() ??
      undefined

    const dialogOptions: MessageBoxOptions = {
      type: 'warning',
      title: 'Stella Security Confirmation',
      message,
      detail,
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: 'Remember this decision on this device',
      checkboxChecked: true,
    }

    const choice = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions)

    if (choice.response !== 0) {
      return false
    }

    if (choice.checkboxChecked) {
      this.trustedPrivilegedActions.add(key)
      await this.persistPolicy()
    }

    return true
  }

  clearAll() {
    this.trustedPrivilegedActions.clear()
  }
}
