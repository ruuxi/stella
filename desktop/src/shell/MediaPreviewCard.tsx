/**
 * Renders a `DisplayPayload { kind: "media" }` inside the workspace panel.
 * Loads each file via `display.readFile` (the same privileged IPC the PDF
 * viewer uses) and turns the bytes into a Blob URL so videos/audio can
 * stream rather than living entirely in a base64 string.
 */

import { useCallback, useState, type ReactNode } from "react";
import type { MediaAsset } from "@/shared/contracts/display-payload";
import {
  useDisplayFileBlobs,
  type DisplayFileBlob,
} from "@/shared/hooks/use-display-file-data";
import { mediaPreviewDialog } from "@/shell/media-preview-dialog-store";

type MediaPreviewCardProps = {
  asset: MediaAsset;
  prompt?: string;
  capability?: string;
  inDialog?: boolean;
  initialIndex?: number;
};

const filenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? filePath;

const PromptHeader = ({
  prompt,
  capability,
}: {
  prompt?: string;
  capability?: string;
}) => {
  if (!prompt && !capability) return null;
  return (
    <div className="display-media-meta">
      {capability && (
        <span className="display-media-meta__cap">
          {capability.replace(/_/g, " ")}
        </span>
      )}
      {prompt && <p className="display-media-meta__prompt">{prompt}</p>}
    </div>
  );
};

const MediaActions = ({
  filePath,
  copyText,
  copyImage,
  extraAction,
}: {
  filePath?: string;
  copyText?: string;
  copyImage?: DisplayFileBlob | null;
  extraAction?: ReactNode;
}) => {
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    const result = await window.electronAPI?.system?.saveFileAs?.(
      filePath,
      filenameOf(filePath),
    );
    if (!result || result.canceled) return;
    setMessage(result.ok ? "Saved" : (result.error ?? "Could not save"));
  }, [filePath]);

  const handleCopy = useCallback(async () => {
    try {
      if (copyImage) {
        await navigator.clipboard.write([
          new ClipboardItem({
            [copyImage.mimeType || "image/png"]: copyImage.blob,
          }),
        ]);
        setMessage("Copied");
        return;
      }
      if (copyText != null) {
        await navigator.clipboard.writeText(copyText);
        setMessage("Copied");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not copy");
    }
  }, [copyImage, copyText]);

  const canSave = Boolean(filePath && window.electronAPI?.system?.saveFileAs);
  const canCopy = Boolean(copyText != null || copyImage);
  if (!canSave && !canCopy && !extraAction) return null;

  return (
    <div className="display-media__actions">
      {canSave && (
        <button
          type="button"
          className="display-media__action-btn"
          onClick={handleSave}
        >
          Save
        </button>
      )}
      {canCopy && (
        <button
          type="button"
          className="display-media__action-btn"
          onClick={handleCopy}
        >
          Copy
        </button>
      )}
      {extraAction}
      {message && <span className="display-media__action-status">{message}</span>}
    </div>
  );
};

const ImageGallery = ({
  filePaths,
  prompt,
  capability,
  inDialog,
  initialIndex,
}: {
  filePaths: string[];
  prompt?: string;
  capability?: string;
  inDialog?: boolean;
  initialIndex?: number;
}) => {
  const { files, error } = useDisplayFileBlobs(
    filePaths,
    "Media preview requires the Electron host runtime.",
  );
  const [activeIndex, setActiveIndex] = useState(initialIndex ?? 0);

  // Clamp on render rather than syncing via effect — when a new batch with
  // fewer files arrives we want the active selection to slide back into
  // range, but we don't want to schedule an extra render for the common
  // case where file count is stable.
  const safeIndex = Math.max(0, Math.min(activeIndex, files.length - 1));
  const active = files[safeIndex];

  const handleOpenPreview = useCallback(() => {
    mediaPreviewDialog.open({
      asset: { kind: "image", filePaths },
      ...(prompt ? { prompt } : {}),
      ...(capability ? { capability } : {}),
      initialIndex: safeIndex,
    });
  }, [capability, filePaths, prompt, safeIndex]);

  return (
    <div className="display-media display-media--image">
      <PromptHeader prompt={prompt} capability={capability} />
      {error && <p className="display-media__error">{error}</p>}
      <MediaActions
        filePath={filePaths[safeIndex]}
        copyImage={active}
        extraAction={
          !inDialog && active ? (
            <button
              type="button"
              className="display-media__action-btn"
              onClick={handleOpenPreview}
            >
              Open preview
            </button>
          ) : undefined
        }
      />
      {active ? (
        <button
          type="button"
          className="display-media__primary-btn"
          onClick={inDialog ? undefined : handleOpenPreview}
          aria-label="Open full size"
        >
          <img
            src={active.url}
            alt={prompt ?? filenameOf(filePaths[safeIndex])}
            className="display-media__primary-img"
          />
        </button>
      ) : (
        !error && <div className="display-media__loading">Loading…</div>
      )}
      {files.length > 1 && (
        <div className="display-media__strip" role="tablist">
          {files.map((file, i) => (
            <button
              key={filePaths[i]}
              type="button"
              role="tab"
              aria-selected={i === safeIndex}
              className={`display-media__thumb${
                i === safeIndex ? " display-media__thumb--active" : ""
              }`}
              onClick={() => setActiveIndex(i)}
              title={filenameOf(filePaths[i])}
            >
              {file ? (
                <img src={file.url} alt="" />
              ) : (
                <span className="display-media__thumb-dot" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const VideoCard = ({
  filePath,
  prompt,
  capability,
  inDialog,
}: {
  filePath: string;
  prompt?: string;
  capability?: string;
  inDialog?: boolean;
}) => {
  const { files, error } = useDisplayFileBlobs(
    [filePath],
    "Media preview requires the Electron host runtime.",
  );
  const file = files[0];
  return (
    <div className="display-media display-media--video">
      <PromptHeader prompt={prompt} capability={capability} />
      {error && <p className="display-media__error">{error}</p>}
      {file ? (
        <video
          src={file.url}
          controls
          autoPlay
          loop
          muted
          playsInline
          className="display-media__video"
        />
      ) : (
        !error && <div className="display-media__loading">Loading…</div>
      )}
      <MediaActions
        filePath={filePath}
        copyText={filePath}
        extraAction={
          !inDialog && file ? (
            <button
              type="button"
              className="display-media__action-btn"
              onClick={() =>
                mediaPreviewDialog.open({
                  asset: { kind: "video", filePath },
                  ...(prompt ? { prompt } : {}),
                  ...(capability ? { capability } : {}),
                })
              }
            >
              Open preview
            </button>
          ) : undefined
        }
      />
      <div className="display-media__filename">{filenameOf(filePath)}</div>
    </div>
  );
};

const AudioCard = ({
  filePath,
  prompt,
  capability,
  inDialog,
}: {
  filePath: string;
  prompt?: string;
  capability?: string;
  inDialog?: boolean;
}) => {
  const { files, error } = useDisplayFileBlobs(
    [filePath],
    "Media preview requires the Electron host runtime.",
  );
  const file = files[0];
  return (
    <div className="display-media display-media--audio">
      <PromptHeader prompt={prompt} capability={capability} />
      {error && <p className="display-media__error">{error}</p>}
      <div className="display-media__audio-card">
        <div className="display-media__audio-icon" aria-hidden>
          ♪
        </div>
        <div className="display-media__audio-body">
          <div className="display-media__filename">{filenameOf(filePath)}</div>
          {file ? (
            <audio
              src={file.url}
              controls
              autoPlay
              className="display-media__audio"
            />
          ) : (
            !error && <div className="display-media__loading">Loading…</div>
          )}
          <MediaActions
            filePath={filePath}
            copyText={filePath}
            extraAction={
              !inDialog && file ? (
                <button
                  type="button"
                  className="display-media__action-btn"
                  onClick={() =>
                    mediaPreviewDialog.open({
                      asset: { kind: "audio", filePath },
                      ...(prompt ? { prompt } : {}),
                      ...(capability ? { capability } : {}),
                    })
                  }
                >
                  Open preview
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
};

const DownloadCard = ({
  filePath,
  label,
  prompt,
  capability,
  variant,
  inDialog,
}: {
  filePath: string;
  label: string;
  prompt?: string;
  capability?: string;
  variant: "model3d" | "download";
  inDialog?: boolean;
}) => {
  const handleReveal = useCallback(() => {
    window.electronAPI?.system?.showItemInFolder?.(filePath);
  }, [filePath]);

  return (
    <div
      className={`display-media display-media--${
        variant === "model3d" ? "model3d" : "download"
      }`}
    >
      <PromptHeader prompt={prompt} capability={capability} />
      <div className="display-media__download-card">
        <div className="display-media__download-icon" aria-hidden>
          {variant === "model3d" ? "◆" : "↓"}
        </div>
        <div className="display-media__download-body">
          <div className="display-media__download-label">{label}</div>
          <div className="display-media__filename">{filenameOf(filePath)}</div>
          <MediaActions
            filePath={filePath}
            copyText={filePath}
            extraAction={
              <>
                {!inDialog && (
                  <button
                    type="button"
                    className="display-media__action-btn"
                    onClick={() =>
                      mediaPreviewDialog.open({
                        asset:
                          variant === "model3d"
                            ? { kind: "model3d", filePath, label }
                            : { kind: "download", filePath, label },
                        ...(prompt ? { prompt } : {}),
                        ...(capability ? { capability } : {}),
                      })
                    }
                  >
                    Open preview
                  </button>
                )}
                <button
                  type="button"
                  className="display-media__action-btn"
                  onClick={handleReveal}
                >
                  Reveal in Finder
                </button>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
};

const TextCard = ({
  text,
  prompt,
  capability,
}: {
  text: string;
  prompt?: string;
  capability?: string;
}) => (
  <div className="display-media display-media--text">
    <PromptHeader prompt={prompt} capability={capability} />
    <MediaActions copyText={text} />
    <div className="display-media__text">{text}</div>
  </div>
);

export const MediaPreviewCard = ({
  asset,
  prompt,
  capability,
  inDialog,
  initialIndex,
}: MediaPreviewCardProps) => {
  switch (asset.kind) {
    case "image":
      return (
        <ImageGallery
          filePaths={asset.filePaths}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
          {...(inDialog ? { inDialog } : {})}
          {...(initialIndex !== undefined ? { initialIndex } : {})}
        />
      );
    case "video":
      return (
        <VideoCard
          filePath={asset.filePath}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
          {...(inDialog ? { inDialog } : {})}
        />
      );
    case "audio":
      return (
        <AudioCard
          filePath={asset.filePath}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
          {...(inDialog ? { inDialog } : {})}
        />
      );
    case "model3d":
      return (
        <DownloadCard
          filePath={asset.filePath}
          label={asset.label ?? "3D model"}
          variant="model3d"
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
          {...(inDialog ? { inDialog } : {})}
        />
      );
    case "download":
      return (
        <DownloadCard
          filePath={asset.filePath}
          label={asset.label}
          variant="download"
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
          {...(inDialog ? { inDialog } : {})}
        />
      );
    case "text":
      return (
        <TextCard
          text={asset.text}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
        />
      );
  }
};
