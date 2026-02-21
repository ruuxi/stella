import { useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/dialog";
import "./RuntimeModeDialog.css";

type RuntimeStatus = {
  mode: "local" | "cloud_247";
  enabled: boolean;
  cloudDevice: {
    spriteName: string;
    status: string;
    setupComplete: boolean;
    lastActiveAt: number;
  } | null;
};

interface RuntimeModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const RuntimeModeDialog = ({ open, onOpenChange }: RuntimeModeDialogProps) => {
  const runtimeStatus = useQuery(
    api.agent.cloud_devices.get247Status,
    open ? {} : "skip",
  ) as RuntimeStatus | undefined;
  const set247Enabled = useAction(api.agent.cloud_devices.set247Enabled);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnabled = runtimeStatus?.enabled === true;
  const statusLabel = useMemo(() => {
    if (!runtimeStatus) return "Loading status...";
    if (!runtimeStatus.cloudDevice) {
      return isEnabled ? "24/7 enabled (provisioning...)" : "Local-only mode";
    }
    const suffix = runtimeStatus.cloudDevice.setupComplete ? "ready" : "setting up";
    return `24/7 ${isEnabled ? "enabled" : "disabled"} - ${runtimeStatus.cloudDevice.status} (${suffix})`;
  }, [runtimeStatus, isEnabled]);

  const handleToggle = async () => {
    if (!runtimeStatus || isSaving) return;
    setError(null);
    setIsSaving(true);
    try {
      await set247Enabled({ enabled: !runtimeStatus.enabled });
    } catch (toggleError) {
      setError((toggleError as Error).message ?? "Failed to update 24/7 mode.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit>
        <DialogHeader>
          <DialogTitle>Runtime Mode</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogDescription>
          Stella runs on your computer by default. Enable 24/7 when you want cloud execution while
          your computer is unavailable.
        </DialogDescription>
        <DialogBody>
          <div className="runtime-mode-status">
            <div className="runtime-mode-status-label">Current mode</div>
            <div className="runtime-mode-status-value">{statusLabel}</div>
            {runtimeStatus?.cloudDevice ? (
              <div className="runtime-mode-status-meta">
                Sprite: {runtimeStatus.cloudDevice.spriteName}
              </div>
            ) : null}
          </div>

          <div className="runtime-mode-actions">
            <Button
              type="button"
              variant={isEnabled ? "secondary" : "primary"}
              size="large"
              disabled={!runtimeStatus || isSaving}
              onClick={handleToggle}
            >
              {isSaving
                ? isEnabled
                  ? "Disabling 24/7..."
                  : "Enabling 24/7..."
                : isEnabled
                  ? "Disable 24/7"
                  : "Enable 24/7"}
            </Button>
          </div>

          {error ? <div className="runtime-mode-error">{error}</div> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
