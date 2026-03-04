import { StellaAnimation } from "@/app/shell/ascii-creature/StellaAnimation";
import { CometSpinner } from "@/ui/comet-spinner";

export type SelfModOverlayPhase = "active" | "hold" | "fade";

type SelfModUpdateOverlayProps = {
  visible: boolean;
  phase: SelfModOverlayPhase;
  message: string;
};

export const SelfModUpdateOverlay = ({ visible, phase, message }: SelfModUpdateOverlayProps) => {
  if (!visible) return null;

  return (
    <div className="selfmod-update-overlay" data-phase={phase} role="status" aria-live="polite">
      <div className="selfmod-update-overlay__content">
        <div className="selfmod-update-overlay__orb">
          <div className="selfmod-update-overlay__ring" aria-hidden="true">
            <CometSpinner />
          </div>
          <div className="selfmod-update-overlay__animation">
            <StellaAnimation width={28} height={28} maxDpr={1} frameSkip={1} />
          </div>
        </div>
        <p className="selfmod-update-overlay__message">{message}</p>
      </div>
    </div>
  );
};
