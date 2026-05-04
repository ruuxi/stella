import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import { useOfficePreview } from "./office-preview-store";
import { useFilePreviewActions } from "./hooks/use-file-preview-actions";
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
    <section className="office-preview-card">
      <header className="office-preview-card__header">
        <div className="office-preview-card__title-group">
          <span className="office-preview-card__eyebrow">{statusLabel}</span>
          <div className="office-preview-card__title" title={previewRef.sourcePath}>
            {title}
          </div>
        </div>
        {updatedAtLabel && (
          <span className="office-preview-card__timestamp">
            Updated {updatedAtLabel}
          </span>
        )}
        <div className="office-preview-card__actions">
          <button
            type="button"
            className="office-preview-card__action"
            onClick={handleSave}
          >
            Save
          </button>
          <button
            type="button"
            className="office-preview-card__action"
            onClick={handleCopy}
          >
            Copy
          </button>
          {actionStatus && (
            <span className="office-preview-card__action-status">
              {actionStatus}
            </span>
          )}
        </div>
      </header>

      {snapshot?.status === "error" ? (
        <div className="office-preview-card__placeholder office-preview-card__placeholder--error">
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
        <div className="office-preview-card__placeholder">
          Stella is preparing a live preview for this document.
        </div>
      )}
    </section>
  );
}
