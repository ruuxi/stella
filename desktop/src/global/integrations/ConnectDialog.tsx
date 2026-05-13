import { useCallback, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { INTEGRATIONS } from "./integration-configs";
import { IntegrationGridCard, IntegrationDetailArea } from "./IntegrationCard";
import { PhoneAccessConnectCard } from "@/global/settings/PhoneAccessCard";
import { ConnectHeroAnimation } from "./ConnectHeroAnimation";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import "./ConnectDialog.css";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PHONE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path
      fill="currentColor"
      d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"
    />
  </svg>
);

const allIntegrations = INTEGRATIONS;

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(
    undefined,
  );
  const navigate = useNavigate();
  const { hasConnectedAccount } = useAuthSessionState();
  const isSignedIn = hasConnectedAccount;

  const handleSignIn = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown> | undefined) => ({
        ...(prev ?? {}),
        dialog: "auth" as const,
      }),
    });
  }, [navigate]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setSelectedProvider(undefined);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleBack = useCallback(() => {
    setSelectedProvider(undefined);
  }, []);

  const cardClickHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    handlers["phone"] = () => setSelectedProvider("phone");
    for (const integration of allIntegrations) {
      handlers[integration.provider] = () => setSelectedProvider(integration.provider);
    }
    return handlers;
  }, []);

  const phoneComingSoon = true;

  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        fit
        className="connect-dialog"
        data-has-selection={hasSelection || undefined}
      >
        <DialogHeader>
          {hasSelection ? (
            <button
              type="button"
              className="connect-back-button"
              onClick={handleBack}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <DialogTitle>
            {isPhoneSelected
              ? "Connect to Stella App"
              : selectedIntegration
                ? selectedIntegration.displayName
                : "Connect"}
          </DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          {!hasSelection && (
            <div className="connect-hero-section">
              <p className="connect-hero-tagline">
                Message Stella from any platform you like — chat naturally, or ask
                it to get things done right on your computer.
              </p>
              <ConnectHeroAnimation />
              {!isSignedIn && (
                <button
                  type="button"
                  className="pill-btn pill-btn--primary connect-signin-pill"
                  onClick={handleSignIn}
                >
                  Sign in to Stella to connect
                </button>
              )}
            </div>
          )}
          <div className="connect-dialog-main">
            {hasSelection ? (
              <div className="connect-full-view">
                {isPhoneSelected && <PhoneAccessConnectCard />}
                {selectedIntegration && (
                  <IntegrationDetailArea integration={selectedIntegration} />
                )}
              </div>
            ) : (
              <>
                <button
                  className="connect-grid-card connect-grid-card--wide"
                  onClick={cardClickHandlers["phone"]}
                  type="button"
                  disabled={!isSignedIn || phoneComingSoon}
                  aria-disabled={!isSignedIn || phoneComingSoon || undefined}
                >
                  <span className="connect-grid-card-icon">{PHONE_ICON}</span>
                  <span className="connect-grid-card-name">Connect to Stella App</span>
                  {phoneComingSoon && (
                    <span className="connect-grid-card-soon">Coming soon</span>
                  )}
                </button>
                <p className="connect-section-title">Integrations</p>
                <div className="connect-grid">
                  {allIntegrations.map((integration) => (
                    <IntegrationGridCard
                      key={integration.provider}
                      integration={integration}
                      isSelected={false}
                      onClick={cardClickHandlers[integration.provider]}
                      disabled={!isSignedIn}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
