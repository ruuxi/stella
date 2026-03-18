import { useState } from "react";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { CometSpinner } from "@/ui/comet-spinner";
import "./self-mod-test-dialog.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MOCK_FEATURES = [
  { featureId: "retro-dashboard", name: "Retro Dashboard", tainted: false },
  { featureId: "weather-widget", name: "Weather Widget", tainted: true },
  { featureId: "custom-sidebar", name: "Custom Sidebar", tainted: false },
];

function ErrorBoundaryPreview() {
  return (
    <div className="selfmod-test-preview selfmod-test-preview--tall">
      <div className="error-boundary">
        <div className="error-boundary-content">
          <div className="error-boundary-comet-wrapper">
            <CometSpinner size={64} headWidth={3} className="error-boundary-comet" />
            <img src="./stella-logo.svg" alt="" className="error-boundary-logo" />
          </div>
          <h2>Oops, I made a mistake</h2>
          <p>
            I ran into an issue while updating your interface. Give me a moment
            to fix it, or you can undo recent changes below.
          </p>
          <p className="error-boundary-status">
            Working on a fix...
          </p>
          <div className="error-boundary-feature-list">
            {MOCK_FEATURES.map((feature) => (
              <Button
                key={feature.featureId}
                variant="secondary"
                size="large"
                onClick={() => {}}
                className="error-boundary-feature-btn"
              >
                {feature.tainted
                  ? `Undo ${feature.name} (external edits)`
                  : `Undo ${feature.name}`}
              </Button>
            ))}
          </div>
          <div className="error-boundary-actions">
            <Button variant="primary" size="large" onClick={() => {}}>
              Undo latest update
            </Button>
            <Button variant="ghost" size="large" onClick={() => {}}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ViteErrorTrigger() {
  const [triggered, setTriggered] = useState(false);

  const trigger = async () => {
    await window.electronAPI?.agent.triggerViteError();
    setTriggered(true);
  };

  const fix = async () => {
    await window.electronAPI?.agent.fixViteError();
    setTriggered(false);
  };

  return (
    <div className="selfmod-test-preview selfmod-test-preview--bounded selfmod-test-trigger-section">
      <p className="selfmod-test-trigger-desc">
        This writes a broken .tsx file to trigger Vite's real error overlay with
        the injected revert buttons. The overlay appears behind this dialog.
      </p>
      <div className="selfmod-test-trigger-actions">
        <Button
          variant="primary"
          size="large"
          onClick={() => void trigger()}
          disabled={triggered}
        >
          {triggered ? "Error triggered" : "Trigger compile error"}
        </Button>
        {triggered && (
          <Button
            variant="secondary"
            size="large"
            onClick={() => void fix()}
          >
            Fix error
          </Button>
        )}
      </div>
    </div>
  );
}

function RecoveryPagePreview() {
  return (
    <div className="selfmod-test-preview selfmod-test-preview--bounded">
      <iframe
        src="./electron/recovery.html"
        title="Recovery Page Preview"
        className="selfmod-test-iframe"
      />
    </div>
  );
}

export default function SelfModTestDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="xl" className="selfmod-test-content">
        <Dialog.Header>
          <Dialog.Title>Self-Mod UI Preview</Dialog.Title>
          <Dialog.Description>
            Preview self-modification UI components.
          </Dialog.Description>
          <Dialog.CloseButton />
        </Dialog.Header>
        <Dialog.Body>
          <div className="selfmod-test-grid">
            <div className="selfmod-test-section">
              <span className="selfmod-test-section__label">
                Error Boundary (React crash)
              </span>
              <ErrorBoundaryPreview />
            </div>

            <div className="selfmod-test-section">
              <span className="selfmod-test-section__label">
                Vite Error Overlay (compile error + revert buttons)
              </span>
              <ViteErrorTrigger />
            </div>

            <div className="selfmod-test-section">
              <span className="selfmod-test-section__label">
                Recovery Page (last resort)
              </span>
              <RecoveryPagePreview />
            </div>
          </div>
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
