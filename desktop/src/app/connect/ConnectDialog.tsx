import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/components/dialog";
import { Accordion } from "@/components/accordion";
import { INTEGRATIONS } from "./integration-configs";
import { IntegrationCard } from "./IntegrationCard";
import "../ConnectDialog.css";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const [expandedProvider, setExpandedProvider] = useState<string | undefined>(
    undefined,
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setExpandedProvider(undefined);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="connect-dialog">
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogDescription>
          Link Stella to your messaging platforms.
        </DialogDescription>
        <DialogBody>
          <Accordion
            type="single"
            collapsible
            value={expandedProvider}
            onValueChange={setExpandedProvider}
          >
            {INTEGRATIONS.map((integration) => (
              <IntegrationCard
                key={integration.provider}
                integration={integration}
                isExpanded={expandedProvider === integration.provider}
              />
            ))}
          </Accordion>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
