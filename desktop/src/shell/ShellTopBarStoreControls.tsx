import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

export function ShellTopBarStoreControls() {
  return (
    <div className="shell-topbar-store-controls" aria-label="Store navigation">
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.goBack()}
        aria-label="Go back in Store"
        title="Back"
      >
        <ArrowLeft size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.goForward()}
        aria-label="Go forward in Store"
        title="Forward"
      >
        <ArrowRight size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.reload()}
        aria-label="Reload Store"
        title="Reload"
      >
        <RotateCw size={13.5} strokeWidth={1.75} />
      </button>
    </div>
  );
}
