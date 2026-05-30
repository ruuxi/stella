import { useCallback, useEffect, useRef, useState } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogCloseButton,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Switch } from "@/ui/switch";
import { getPlatform } from "@/platform/electron/platform";
import { BROWSERS, type BrowserId } from "@/global/onboarding/onboarding-flow";
import type {
  BrowserProfile,
  CadenceReportCadenceId,
  CadenceReportSettings,
} from "@/shared/types/electron";
import "./reports-dialog.css";

const CADENCE_ROWS: {
  id: CadenceReportCadenceId;
  title: string;
  desc: string;
}[] = [
  {
    id: "4h",
    title: "Every 4 hours",
    desc: "Quick, timely next-step ideas from your recent activity.",
  },
  {
    id: "daily",
    title: "Daily",
    desc: "A daily roundup of workflows, reminders, and small app ideas.",
  },
  {
    id: "weekly",
    title: "Weekly",
    desc: "A weekly digest of broader patterns worth saving.",
  },
];

const EMPTY_SETTINGS: CadenceReportSettings = {
  schedules: { "4h": false, daily: false, weekly: false },
  browser: null,
  profile: null,
};

const browserLabel = (id: string | null): string => {
  if (!id) return "";
  return BROWSERS.find((b) => b.id === id)?.label ?? id;
};

type ReportsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ReportsDialog({ open, onOpenChange }: ReportsDialogProps) {
  const platform = getPlatform();
  const [settings, setSettings] = useState<CadenceReportSettings | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [editingBrowser, setEditingBrowser] = useState(false);
  const settingsRef = useRef<CadenceReportSettings>(EMPTY_SETTINGS);
  settingsRef.current = settings ?? EMPTY_SETTINGS;

  const availableBrowsers = BROWSERS.filter((browser) =>
    platform !== "darwin" ? browser.id !== "safari" : true,
  );

  const loadProfiles = useCallback(async (browserId: string | null) => {
    if (!browserId) {
      setProfiles([]);
      return;
    }
    try {
      const next =
        await window.electronAPI?.discovery.listProfiles?.(browserId);
      setProfiles(next ?? []);
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEditingBrowser(false);
    void (async () => {
      try {
        const loaded =
          await window.electronAPI?.system?.getCadenceReportSettings?.();
        if (cancelled) return;
        const next = loaded ?? EMPTY_SETTINGS;
        setSettings(next);
        void loadProfiles(next.browser);
      } catch {
        if (!cancelled) setSettings(EMPTY_SETTINGS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadProfiles]);

  const persist = useCallback(async (next: CadenceReportSettings) => {
    setSettings(next);
    settingsRef.current = next;
    try {
      const saved =
        await window.electronAPI?.system?.setCadenceReportSettings?.(next);
      if (saved) {
        setSettings(saved);
        settingsRef.current = saved;
      }
    } catch {
      // best-effort; the local state already reflects the user's intent
    }
  }, []);

  const toggleCadence = useCallback(
    (id: CadenceReportCadenceId, value: boolean) => {
      const current = settingsRef.current;
      void persist({
        ...current,
        schedules: { ...current.schedules, [id]: value },
      });
    },
    [persist],
  );

  const selectBrowser = useCallback(
    async (browserId: BrowserId) => {
      const current = settingsRef.current;
      let nextProfiles: BrowserProfile[] = [];
      try {
        nextProfiles =
          (await window.electronAPI?.discovery.listProfiles?.(browserId)) ?? [];
      } catch {
        nextProfiles = [];
      }
      setProfiles(nextProfiles);
      // Keep the picker expanded after a selection so the profile pills for
      // the chosen browser stay visible (selecting a browser sets
      // `value.browser`, which would otherwise collapse the picker).
      setEditingBrowser(true);
      void persist({
        ...current,
        browser: browserId,
        profile: nextProfiles[0]?.id ?? null,
      });
    },
    [persist],
  );

  const selectProfile = useCallback(
    (profileId: string) => {
      const current = settingsRef.current;
      void persist({ ...current, profile: profileId });
    },
    [persist],
  );

  const value = settings ?? EMPTY_SETTINGS;
  const hasBrowser = Boolean(value.browser);
  const showPicker = !hasBrowser || editingBrowser;
  const anyEnabled = Object.values(value.schedules).some(Boolean);
  const profileName = value.profile
    ? (profiles.find((p) => p.id === value.profile)?.name ?? value.profile)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit size="md" className="reports-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Reports</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Choose how often Stella compiles background reports and which
            browser they read from.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="reports-dialog-close" />
        <DialogBody className="reports-dialog-body">
          <header className="reports-dialog-head">
            <h2 className="reports-dialog-title">Reports</h2>
            <p className="reports-dialog-subtitle">
              Stella can quietly compile briefs of ideas worth acting on. Turn
              on the cadences you want.
            </p>
          </header>

          <div className="reports-dialog-rows">
            {CADENCE_ROWS.map((row) => (
              <div key={row.id} className="reports-dialog-row">
                <div className="reports-dialog-row-text">
                  <span className="reports-dialog-row-title">{row.title}</span>
                  <span className="reports-dialog-row-desc">{row.desc}</span>
                </div>
                <Switch
                  label={row.title}
                  hideLabel
                  checked={value.schedules[row.id]}
                  onCheckedChange={(checked) =>
                    toggleCadence(row.id, Boolean(checked))
                  }
                />
              </div>
            ))}
          </div>

          <div className="reports-dialog-browser">
            <div className="reports-dialog-browser-head">
              <span className="reports-dialog-row-title">Browsing data</span>
              {hasBrowser && !editingBrowser ? (
                <button
                  type="button"
                  className="reports-dialog-change"
                  onClick={() => setEditingBrowser(true)}
                >
                  Change
                </button>
              ) : null}
            </div>

            {showPicker ? (
              <>
                <p className="reports-dialog-hint">
                  {anyEnabled && !hasBrowser
                    ? "Pick the browser Stella should read so reports use the right history."
                    : "Reports learn from the sites you visit. Choose which browser to read."}
                </p>
                <div className="reports-dialog-pills">
                  {availableBrowsers.map((browser) => (
                    <button
                      key={browser.id}
                      type="button"
                      className="reports-dialog-pill"
                      data-active={value.browser === browser.id}
                      onClick={() => void selectBrowser(browser.id)}
                    >
                      {browser.label}
                    </button>
                  ))}
                </div>

                {value.browser && profiles.length > 0 ? (
                  <>
                    <span className="reports-dialog-sublabel">Profile</span>
                    <div className="reports-dialog-pills">
                      {profiles.map((profile) => (
                        <button
                          key={profile.id}
                          type="button"
                          className="reports-dialog-pill"
                          data-active={value.profile === profile.id}
                          onClick={() => selectProfile(profile.id)}
                        >
                          {profile.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <p className="reports-dialog-browser-current">
                {browserLabel(value.browser)}
                {profileName ? ` · ${profileName}` : ""}
              </p>
            )}
          </div>

          <button
            type="button"
            className="reports-dialog-cta"
            onClick={() => onOpenChange(false)}
          >
            Done
          </button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
