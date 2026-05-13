import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

type ShellTopBarWebControlsProps = {
  surfaceLabel: string;
};

export function ShellTopBarWebControls({
  surfaceLabel,
}: ShellTopBarWebControlsProps) {
  return (
    <div
      className="shell-topbar-store-controls"
      aria-label={`${surfaceLabel} navigation`}
    >
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.goBack()}
        aria-label={`Go back in ${surfaceLabel}`}
      >
        <ArrowLeft size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.goForward()}
        aria-label={`Go forward in ${surfaceLabel}`}
      >
        <ArrowRight size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => void window.electronAPI?.storeWeb?.reload()}
        aria-label={`Reload ${surfaceLabel}`}
      >
        <RotateCw size={13.5} strokeWidth={1.75} />
      </button>
    </div>
  );
}
