import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { listLocalEvents } from "@/app/chat/services/local-chat-store";
import { Compass, Smartphone } from "lucide-react";
import "./welcome-dialog.css";

const WELCOME_DIALOG_SEEN_KEY = "stella-welcome-dialog-seen";

function useWelcomeMessage(conversationId: string | null): string | null {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const events = await listLocalEvents(conversationId, 50);
        if (cancelled) return;
        const welcome = events.find(
          (e) => e.type === "assistant_message" && e.payload,
        );
        if (welcome?.payload) {
          const text = (welcome.payload as { text?: string }).text;
          if (text) setMessage(text);
        }
      } catch {
        // silent - fallback will be used
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return message;
}

type WelcomeDialogProps = {
  conversationId: string | null;
  onConnect: () => void;
};

export function WelcomeDialog({
  conversationId,
  onConnect,
}: WelcomeDialogProps) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_DIALOG_SEEN_KEY) !== "true";
    } catch {
      return false;
    }
  });

  const welcomeMessage = useWelcomeMessage(open ? conversationId : null);

  const handleClose = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(WELCOME_DIALOG_SEEN_KEY, "true");
    } catch {
      // ignore
    }
  }, []);

  const handleConnect = useCallback(() => {
    handleClose();
    onConnect();
  }, [handleClose, onConnect]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent fit size="md" className="welcome-dialog-content">
        <DialogCloseButton className="welcome-dialog-close" />
        <DialogBody className="welcome-dialog-body">
          <p className="welcome-dialog-message">
            {welcomeMessage ?? "Welcome to Stella"}
          </p>

          <div className="welcome-dialog-cards">
            <div className="welcome-dialog-card">
              <div className="welcome-dialog-card-icon">
                <Compass size={20} />
              </div>
              <div className="welcome-dialog-card-text">
                <h3>Personalized for you</h3>
                <p>
                  Tap any suggestion on the home screen to get started. They're
                  tailored to you based on what you shared during setup.
                </p>
              </div>
            </div>

            <div
              className="welcome-dialog-card welcome-dialog-card--interactive"
              onClick={handleConnect}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            >
              <div className="welcome-dialog-card-icon">
                <Smartphone size={20} />
              </div>
              <div className="welcome-dialog-card-text">
                <h3>Take Stella with you</h3>
                <p>
                  Connect your phone so you can message Stella anywhere. Open{" "}
                  <strong>Connect</strong> in the sidebar to pair your device.
                </p>
              </div>
              <span className="welcome-dialog-card-arrow">&rsaquo;</span>
            </div>
          </div>

          <button
            type="button"
            className="welcome-dialog-cta"
            onClick={handleClose}
          >
            Get started
          </button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
