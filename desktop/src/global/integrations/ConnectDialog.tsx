import { useCallback, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
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

const ConnectHeroAnimation = () => {
  return (
    <div className="connect-hero-animation" aria-hidden="true">
      <svg viewBox="0 0 400 140" className="connect-hero-svg">
        <defs>
          <linearGradient id="signal-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--interactive, var(--primary))" stopOpacity="0" />
            <stop offset="20%" stopColor="var(--interactive, var(--primary))" stopOpacity="0.8" />
            <stop offset="80%" stopColor="var(--interactive, var(--primary))" stopOpacity="0.8" />
            <stop offset="100%" stopColor="var(--interactive, var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        
        {/* Left: Phone + Hand */}
        <g className="anim-phone-group">
          {/* Phone outline */}
          <rect x="80" y="30" width="50" height="90" rx="8" fill="var(--background)" stroke="var(--border-strong)" strokeWidth="2" />
          <rect x="84" y="34" width="42" height="82" rx="4" fill="color-mix(in srgb, var(--card) 40%, transparent)" stroke="var(--border-weak)" strokeWidth="1" />
          
          {/* UI placeholder */}
          <rect x="94" y="44" width="22" height="4" rx="2" fill="var(--border-strong)" />
          <rect x="94" y="54" width="16" height="4" rx="2" fill="var(--border-weak)" />
          
          {/* Glowing pulse on phone screen */}
          <circle cx="105" cy="78" r="14" fill="var(--interactive, var(--primary))" opacity="0.1" className="anim-pulse" />
          <circle cx="105" cy="78" r="5" fill="var(--interactive, var(--primary))" />

          {/* Hand hovering over phone */}
          <g className="anim-cursor-phone">
            <path d="M106 71v-6a2 2 0 0 0-4 0v10.5l-1.5-1.5a2 2 0 0 0-2.8 2.8l4.8 4.8a5 5 0 0 0 7 0l1.5-1.5a2 2 0 0 0 0-2.8z" fill="var(--text-strong)" stroke="var(--background)" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="105" cy="78" r="10" fill="var(--interactive, var(--primary))" opacity="0" className="anim-click-ripple-phone" />
          </g>
        </g>

        {/* Center: Signal waves */}
        <g className="anim-signals">
          <path d="M 145 78 Q 190 50 235 65" fill="none" stroke="url(#signal-grad)" strokeWidth="2.5" strokeDasharray="4 6" className="anim-signal-line" />
        </g>

        {/* Right: Monitor + Cursor */}
        <g className="anim-monitor-group">
          {/* Stand */}
          <path d="M285 95 L275 115 H315 L305 95" fill="var(--background)" stroke="var(--border-strong)" strokeWidth="2" strokeLinejoin="round" />
          <path d="M275 115 H315" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
          
          {/* Monitor outline */}
          <rect x="240" y="25" width="110" height="70" rx="6" fill="var(--background)" stroke="var(--border-strong)" strokeWidth="2" />
          <rect x="244" y="29" width="102" height="62" rx="3" fill="color-mix(in srgb, var(--card) 40%, transparent)" stroke="var(--border-weak)" strokeWidth="1" />
          
          {/* UI placeholder */}
          <rect x="254" y="38" width="40" height="5" rx="2.5" fill="var(--border-strong)" />
          <rect x="254" y="50" width="30" height="4" rx="2" fill="var(--border-weak)" />
          <rect x="254" y="60" width="60" height="4" rx="2" fill="var(--border-weak)" />

          {/* Cursor Hovering */}
          <g className="anim-cursor">
            <path d="M280 50 L292 62 L286 63 L289 70 L285 71 L282 64 L276 68 Z" fill="var(--text-strong)" stroke="var(--background)" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="280" cy="50" r="10" fill="var(--interactive, var(--primary))" opacity="0" className="anim-click-ripple" />
          </g>
        </g>
      </svg>
    </div>
  );
};

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(
    undefined,
  );

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

  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="connect-dialog">
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
                >
                  <span className="connect-grid-card-icon">{PHONE_ICON}</span>
                  <span className="connect-grid-card-name">Connect to Stella App</span>
                </button>
                <p className="connect-section-title">Integrations</p>
                <div className="connect-grid">
                  {allIntegrations.map((integration) => (
                    <IntegrationGridCard
                      key={integration.provider}
                      integration={integration}
                      isSelected={false}
                      onClick={cardClickHandlers[integration.provider]}
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

