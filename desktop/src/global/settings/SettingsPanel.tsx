import type { ReactNode } from "react";

export function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <div className="settings-panel-wrap">
      <div className="settings-panel">{children}</div>
    </div>
  );
}
