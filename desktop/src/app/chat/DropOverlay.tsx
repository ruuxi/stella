import { AnimatePresence, motion } from "motion/react";
import "./drop-overlay.css";

type DropOverlayProps = {
  visible: boolean;
  variant?: "full" | "mini" | "orb";
};

function DropIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function DropOverlay({ visible, variant = "full" }: DropOverlayProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="drop-overlay"
          className={`drop-overlay drop-overlay--${variant}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="drop-overlay-content">
            <DropIcon />
            <span className="drop-overlay-label">Drop files here</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
