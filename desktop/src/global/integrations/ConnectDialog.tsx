import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, Smartphone } from "@/ui/icons";
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

interface ConnectSurfaceBodyProps {
  selectedProvider: string | undefined;
  onSelectedProviderChange: (provider: string | undefined) => void;
}

const PHONE_ICON = <Smartphone strokeWidth={1.75} aria-hidden />;

const allIntegrations = INTEGRATIONS;

const ConnectSurfaceBody = ({
  selectedProvider,
  onSelectedProviderChange,
}: ConnectSurfaceBodyProps) => {
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

  const cardClickHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    handlers["phone"] = () => onSelectedProviderChange("phone");
    for (const integration of allIntegrations) {
      handlers[integration.provider] = () =>
        onSelectedProviderChange(integration.provider);
    }
    return handlers;
  }, [onSelectedProviderChange]);

  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  return (
    <>
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
              disabled={!isSignedIn}
              aria-disabled={!isSignedIn || undefined}
            >
              <span className="connect-grid-card-icon">{PHONE_ICON}</span>
              <span className="connect-grid-card-name">
                Connect to Stella App
              </span>
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
    </>
  );
};

export const ConnectPanel = () => {
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(
    undefined,
  );
  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  return (
    <div
      className="connect-dialog connect-panel"
      data-has-selection={hasSelection || undefined}
      data-phone-detail={isPhoneSelected || undefined}
    >
      {hasSelection ? (
        <header className="connect-panel__detail-header">
          <button
            type="button"
            className="connect-back-button"
            onClick={() => setSelectedProvider(undefined)}
            aria-label="Back to connections"
            title="Back to connections"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="connect-panel__detail-title">
            {isPhoneSelected
              ? "Connect to Stella App"
              : selectedIntegration?.displayName}
          </span>
        </header>
      ) : null}
      <div data-slot="dialog-body">
        <ConnectSurfaceBody
          selectedProvider={selectedProvider}
          onSelectedProviderChange={setSelectedProvider}
        />
      </div>
    </div>
  );
};

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(
    undefined,
  );
  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setSelectedProvider(undefined);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        fit
        className="connect-dialog"
        data-has-selection={hasSelection || undefined}
        data-phone-detail={isPhoneSelected || undefined}
      >
        <DialogHeader>
          {hasSelection ? (
            <button
              type="button"
              className="connect-back-button"
              onClick={() => setSelectedProvider(undefined)}
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
          <ConnectSurfaceBody
            selectedProvider={selectedProvider}
            onSelectedProviderChange={setSelectedProvider}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
