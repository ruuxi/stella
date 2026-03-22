import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/ui/dialog";
import {
  LEGAL_TITLES,
  TERMS_OF_SERVICE,
  PRIVACY_POLICY,
  type LegalDocument,
} from "./legal-text";
import "./legal-dialog.css";

const CONTENT: Record<LegalDocument, string> = {
  terms: TERMS_OF_SERVICE,
  privacy: PRIVACY_POLICY,
};

type LegalDialogProps = {
  document: LegalDocument | null;
  onOpenChange: (open: boolean) => void;
};

export const LegalDialog = ({ document, onOpenChange }: LegalDialogProps) => (
  <Dialog open={document !== null} onOpenChange={onOpenChange}>
    <DialogContent size="lg" className="legal-dialog">
      <DialogHeader>
        <DialogTitle>
          {document ? LEGAL_TITLES[document] : ""}
        </DialogTitle>
        <DialogCloseButton />
      </DialogHeader>
      <DialogBody>
        <div className="legal-dialog-scroll">
          <pre className="legal-dialog-text">
            {document ? CONTENT[document] : ""}
          </pre>
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>
);
