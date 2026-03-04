type SelfModUpdateOverlayProps = {
  visible: boolean;
  message: string;
};

export const SelfModUpdateOverlay = ({ visible, message }: SelfModUpdateOverlayProps) => {
  if (!visible) return null;

  return (
    <div className="selfmod-update-overlay" role="status" aria-live="polite">
      <div className="selfmod-update-overlay__card">
        <div className="selfmod-update-overlay__spinner" aria-hidden="true" />
        <p className="selfmod-update-overlay__message">{message}</p>
      </div>
    </div>
  );
};

