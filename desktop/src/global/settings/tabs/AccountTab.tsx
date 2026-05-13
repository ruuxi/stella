import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { deleteAuthUser } from "@/global/auth/services/auth-session";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import type { LegalDocument } from "@/global/legal/legal-text";
import { getSettingsErrorMessage } from "./shared";

type AccountDeleteAction = "data" | "account";

const deleteIndexedDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

async function clearLocalAccountState() {
  clearCachedToken();

  try {
    localStorage.clear();
  } catch {
    /* best-effort local cleanup */
  }

  try {
    sessionStorage.clear();
  } catch {
    /* best-effort local cleanup */
  }

  if (
    typeof indexedDB !== "undefined" &&
    typeof indexedDB.databases === "function"
  ) {
    try {
      const databases = await indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        );
      await Promise.all(names.map(deleteIndexedDatabase));
    } catch {
      /* best-effort local cleanup */
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName)),
      );
    } catch {
      /* best-effort local cleanup */
    }
  }

  await window.electronAPI?.ui.hardReset?.();
}

async function deleteCurrentBetterAuthUser() {
  await deleteAuthUser();
}

interface AccountTabProps {
  onSignOut?: () => void;
  onOpenLegal?: (doc: LegalDocument) => void;
}

export function AccountTab({ onSignOut, onOpenLegal }: AccountTabProps) {
  const { hasConnectedAccount } = useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);
  const [pendingDeleteAction, setPendingDeleteAction] =
    useState<AccountDeleteAction | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const closeDeleteDialog = useCallback(
    (open: boolean) => {
      if (!open && !isDeleting) {
        setPendingDeleteAction(null);
      }
    },
    [isDeleting],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteAction || isDeleting) return;
    const action = pendingDeleteAction;
    setIsDeleting(true);

    try {
      if (action === "data") {
        if (hasConnectedAccount) {
          await resetUserData();
        }
      } else {
        if (!hasConnectedAccount) {
          throw new Error("Sign in before deleting your account.");
        }
        await deleteCurrentBetterAuthUser();
      }

      await clearLocalAccountState();
      showToast(
        action === "data"
          ? "Your Stella data was deleted."
          : "Your Stella account was deleted.",
      );
      window.location.reload();
    } catch (error) {
      console.error(error);
      showToast(
        getSettingsErrorMessage(
          error,
          action === "data"
            ? "Could not delete your data. Please try again."
            : "Could not delete your account. Please try again.",
        ),
      );
      setIsDeleting(false);
      setPendingDeleteAction(null);
    }
  }, [hasConnectedAccount, isDeleting, pendingDeleteAction, resetUserData]);

  const deleteDialogTitle =
    pendingDeleteAction === "account"
      ? "Delete your Stella account?"
      : "Delete your Stella data?";
  const deleteDialogDescription =
    pendingDeleteAction === "account"
      ? "This permanently deletes your account and Stella data. This cannot be undone."
      : "This erases your conversations, memory, settings, and local Stella state. This cannot be undone.";
  const deleteDialogButton =
    pendingDeleteAction === "account" ? "Delete account" : "Delete data";

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Account</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sign out</div>
            <div className="settings-row-sublabel">
              Sign out of Stella on this device.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={onSignOut}
            >
              Sign Out
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete data</div>
            <div className="settings-row-sublabel">
              Erase every conversation, memory, and saved Stella setting.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              onClick={() => setPendingDeleteAction("data")}
              disabled={isDeleting}
            >
              {isDeleting && pendingDeleteAction === "data"
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete account</div>
            <div className="settings-row-sublabel">
              Permanently delete your account and everything in it.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              onClick={() => setPendingDeleteAction("account")}
              disabled={isDeleting || !hasConnectedAccount}
            >
              {isDeleting && pendingDeleteAction === "account"
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Legal</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Terms of Service</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("terms")}
            >
              View
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Privacy Policy</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("privacy")}
            >
              View
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={pendingDeleteAction !== null}
        onOpenChange={closeDeleteDialog}
      >
        <DialogContent
          fit
          className="settings-confirm-dialog"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{deleteDialogTitle}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="settings-confirm-description">
            {deleteDialogDescription}
          </DialogDescription>
          <div className="settings-confirm-actions">
            <Button
              type="button"
              variant="ghost"
              size="large"
              className="pill-btn pill-btn--lg"
              onClick={() => setPendingDeleteAction(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="large"
              data-tone="destructive"
              className="pill-btn pill-btn--danger pill-btn--lg"
              onClick={() => void handleConfirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : deleteDialogButton}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
