import type { ReactNode } from "react";
import "./file-preview-card-shell.css";

type FilePreviewCardShellProps = {
  className?: string;
  headerClassName?: string;
  eyebrow: string;
  title: string;
  titlePath: string;
  meta?: ReactNode;
  actionStatus?: string | null;
  onSave: () => void;
  onCopy: () => void;
  children: ReactNode;
};

export function FilePreviewCardShell({
  className,
  headerClassName,
  eyebrow,
  title,
  titlePath,
  meta,
  actionStatus,
  onSave,
  onCopy,
  children,
}: FilePreviewCardShellProps) {
  return (
    <section className={`file-preview-card${className ? ` ${className}` : ""}`}>
      <header
        className={`file-preview-card__header${
          headerClassName ? ` ${headerClassName}` : ""
        }`}
      >
        <div className="file-preview-card__title-group">
          <span className="file-preview-card__eyebrow">{eyebrow}</span>
          <div className="file-preview-card__title" title={titlePath}>
            {title}
          </div>
        </div>
        {meta}
        <div className="file-preview-card__actions">
          <button
            type="button"
            className="file-preview-card__action"
            onClick={onSave}
          >
            Save
          </button>
          <button
            type="button"
            className="file-preview-card__action"
            onClick={onCopy}
          >
            Copy
          </button>
          {actionStatus ? (
            <span className="file-preview-card__action-status">
              {actionStatus}
            </span>
          ) : null}
        </div>
      </header>
      {children}
    </section>
  );
}
