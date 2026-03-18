import { useCallback, useMemo, useState } from "react";
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
import "./ConnectDialog.css";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const allIntegrations = INTEGRATIONS;

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

  const handleCardSelect = useCallback((provider: string) => {
    setSelectedProvider((prev) => (prev === provider ? undefined : provider));
  }, []);

  const cardClickHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    for (const integration of allIntegrations) {
      handlers[integration.provider] = () => handleCardSelect(integration.provider);
    }
    return handlers;
  }, [handleCardSelect]);

  const selectedIntegration = allIntegrations.find(
    (integration) => integration.provider === selectedProvider,
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="connect-dialog">
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="connect-grid">
            {allIntegrations.map((integration) => (
              <IntegrationGridCard
                key={integration.provider}
                integration={integration}
                isSelected={selectedProvider === integration.provider}
                onClick={cardClickHandlers[integration.provider]}
              />
            ))}
          </div>

          {selectedIntegration && (
            <IntegrationDetailArea
              key={selectedIntegration.provider}
              integration={selectedIntegration}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

