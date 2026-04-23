/**
 * Renders a `DisplayPayload { kind: "media" }` inside the Display sidebar.
 * Loads each file via `display.readFile` (the same privileged IPC the PDF
 * viewer uses) and turns the bytes into a Blob URL so videos/audio can
 * stream rather than living entirely in a base64 string.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MediaAsset } from "@/shared/contracts/display-payload";

type MediaPreviewCardProps = {
  asset: MediaAsset;
  prompt?: string;
  capability?: string;
};

type LoadedFile = {
  url: string;
  mimeType: string;
  blob: Blob;
};

const decodeBase64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  // Allocate an `ArrayBuffer` (not `SharedArrayBuffer`) so the resulting
  // typed view is accepted by Blob's `BlobPart` signature in TS strict mode.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([buffer], { type: mimeType || "application/octet-stream" });
};

const isElectronApiAvailable = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.electronAPI?.display?.readFile === "function";

const filenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? filePath;

/**
 * Hook: read N file paths into Blob URLs. Revokes the URLs on unmount or
 * when the file paths change so we don't leak memory across rapid updates.
 */
const useFileBlobs = (filePaths: string[]) => {
  const [files, setFiles] = useState<(LoadedFile | null)[]>(() =>
    filePaths.map(() => null),
  );
  const [error, setError] = useState<string | null>(null);

  const key = useMemo(() => filePaths.join("|"), [filePaths]);

  useEffect(() => {
    if (!isElectronApiAvailable()) {
      setError("Media preview requires the Electron host runtime.");
      return;
    }

    let cancelled = false;
    setError(null);
    setFiles(filePaths.map(() => null));
    const createdUrls: string[] = [];

    void (async () => {
      const results = await Promise.all(
        filePaths.map(async (filePath): Promise<LoadedFile | null> => {
          try {
            const result =
              await window.electronAPI!.display.readFile(filePath);
            const blob = decodeBase64ToBlob(
              result.contentsBase64,
              result.mimeType,
            );
            const url = URL.createObjectURL(blob);
            createdUrls.push(url);
            return { url, mimeType: result.mimeType, blob };
          } catch (err) {
            if (!cancelled) {
              setError(
                err instanceof Error ? err.message : String(err),
              );
            }
            return null;
          }
        }),
      );
      if (cancelled) {
        for (const u of createdUrls) URL.revokeObjectURL(u);
        return;
      }
      setFiles(results);
    })();

    return () => {
      cancelled = true;
      for (const u of createdUrls) URL.revokeObjectURL(u);
    };
    // `filePaths` reference changes on every render, so key off contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { files, error };
};

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
  copyImage?: LoadedFile | null;
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
}: {
  filePaths: string[];
  prompt?: string;
  capability?: string;
}) => {
  const { files, error } = useFileBlobs(filePaths);
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);

  // Clamp on render rather than syncing via effect — when a new batch with
  // fewer files arrives we want the active selection to slide back into
  // range, but we don't want to schedule an extra render for the common
  // case where file count is stable.
  const safeIndex = Math.max(0, Math.min(activeIndex, files.length - 1));
  const active = files[safeIndex];

  const handleClose = useCallback(() => setLightbox(false), []);

  return (
    <div className="display-media display-media--image">
      <PromptHeader prompt={prompt} capability={capability} />
      {error && <p className="display-media__error">{error}</p>}
      <MediaActions filePath={filePaths[safeIndex]} copyImage={active} />
      {active ? (
        <button
          type="button"
          className="display-media__primary-btn"
          onClick={() => setLightbox(true)}
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
      {lightbox && active && (
        <div
          className="display-media-lightbox"
          onClick={handleClose}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={active.url}
            alt={prompt ?? ""}
            className="display-media-lightbox__img"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="display-media-lightbox__close"
            onClick={handleClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};

const VideoCard = ({
  filePath,
  prompt,
  capability,
}: {
  filePath: string;
  prompt?: string;
  capability?: string;
}) => {
  const { files, error } = useFileBlobs([filePath]);
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
      <MediaActions filePath={filePath} copyText={filePath} />
      <div className="display-media__filename">{filenameOf(filePath)}</div>
    </div>
  );
};

const AudioCard = ({
  filePath,
  prompt,
  capability,
}: {
  filePath: string;
  prompt?: string;
  capability?: string;
}) => {
  const { files, error } = useFileBlobs([filePath]);
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
          <MediaActions filePath={filePath} copyText={filePath} />
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
}: {
  filePath: string;
  label: string;
  prompt?: string;
  capability?: string;
  variant: "model3d" | "download";
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
              <button
                type="button"
                className="display-media__action-btn"
                onClick={handleReveal}
              >
                Reveal in Finder
              </button>
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
}: MediaPreviewCardProps) => {
  switch (asset.kind) {
    case "image":
      return (
        <ImageGallery
          filePaths={asset.filePaths}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
        />
      );
    case "video":
      return (
        <VideoCard
          filePath={asset.filePath}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
        />
      );
    case "audio":
      return (
        <AudioCard
          filePath={asset.filePath}
          {...(prompt ? { prompt } : {})}
          {...(capability ? { capability } : {})}
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
