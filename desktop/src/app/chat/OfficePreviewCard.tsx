import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import { useOfficePreview } from "./office-preview-store";
import { useFilePreviewActions } from "./hooks/use-file-preview-actions";
import { FilePreviewCardShell } from "./FilePreviewCardShell";
import "./office-preview-card.css";

const formatStatusLabel = (status?: string) => {
  if (status === "ready") return "Live preview";
  if (status === "error") return "Preview error";
  if (status === "stopped") return "Preview stopped";
  return "Preparing preview";
};

export function OfficePreviewCard({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) {
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: previewRef.sourcePath,
    suggestedName: previewRef.title,
  });
  const snapshot = useOfficePreview(previewRef.sessionId);
  const title = snapshot?.title ?? previewRef.title;
  const status = snapshot?.status;
  const statusLabel = formatStatusLabel(status);
  const updatedAtLabel =
    snapshot?.updatedAt != null
      ? new Date(snapshot.updatedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <FilePreviewCardShell
      className="office-preview-card"
      eyebrow={statusLabel}
      title={title}
      titlePath={previewRef.sourcePath}
      meta={
        updatedAtLabel ? (
          <span className="office-preview-card__timestamp">
            Updated {updatedAtLabel}
          </span>
        ) : null
      }
      actionStatus={actionStatus}
      onSave={handleSave}
      onCopy={handleCopy}
    >
      {snapshot?.status === "error" ? (
        <div className="file-preview-card__placeholder file-preview-card__placeholder--error office-preview-card__placeholder">
          {snapshot.error?.trim() || "The preview session reported an error."}
        </div>
      ) : snapshot?.html ? (
        <iframe
          className="office-preview-card__frame"
          title={`Office preview: ${title}`}
          sandbox="allow-scripts"
          srcDoc={snapshot.html}
        />
      ) : (
        <div className="file-preview-card__placeholder office-preview-card__placeholder">
          Stella is preparing a live preview for this document.
        </div>
      )}
    </FilePreviewCardShell>
  );
}
