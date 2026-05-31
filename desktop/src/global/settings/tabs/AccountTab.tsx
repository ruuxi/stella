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
import { useT } from "@/shared/i18n";
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
  const t = useT();
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
          throw new Error(t("settings.account.toasts.signInBeforeDelete"));
        }
        await deleteCurrentBetterAuthUser();
      }

      await clearLocalAccountState();
      showToast(
        action === "data"
          ? t("settings.account.toasts.dataDeleted")
          : t("settings.account.toasts.accountDeleted"),
      );
      window.location.reload();
    } catch (error) {
      console.error(error);
      showToast(
        getSettingsErrorMessage(
          error,
          action === "data"
            ? t("settings.account.toasts.deleteDataFailed")
            : t("settings.account.toasts.deleteAccountFailed"),
        ),
      );
      setIsDeleting(false);
      setPendingDeleteAction(null);
    }
  }, [hasConnectedAccount, isDeleting, pendingDeleteAction, resetUserData, t]);

  const deleteDialogTitle =
    pendingDeleteAction === "account"
      ? t("settings.account.dialog.deleteAccountTitle")
      : t("settings.account.dialog.deleteDataTitle");
  const deleteDialogDescription =
    pendingDeleteAction === "account"
      ? t("settings.account.dialog.deleteAccountDescription")
      : t("settings.account.dialog.deleteDataDescription");
  const deleteDialogButton =
    pendingDeleteAction === "account"
      ? t("settings.account.dialog.deleteAccountButton")
      : t("settings.account.dialog.deleteDataButton");

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">{t("settings.account.title")}</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.account.signOut.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.account.signOut.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={onSignOut}
            >
              {t("settings.account.signOut.action")}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.account.deleteData.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.account.deleteData.description")}
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
                ? t("settings.account.deleteData.working")
                : t("settings.account.deleteData.action")}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.account.deleteAccount.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.account.deleteAccount.description")}
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
                ? t("settings.account.deleteAccount.working")
                : t("settings.account.deleteAccount.action")}
            </Button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">
          {t("settings.account.legal.title")}
        </h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.account.legal.terms")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("terms")}
            >
              {t("settings.account.legal.view")}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.account.legal.privacy")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("privacy")}
            >
              {t("settings.account.legal.view")}
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
              {t("common.cancel")}
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
              {isDeleting
                ? t("settings.account.dialog.working")
                : deleteDialogButton}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
