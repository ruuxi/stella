type MediaItem = {
  id?: string;
  url?: string;
  localPath?: string;
  mimeType?: string;
  label?: string;
};

type Props = {
  item: MediaItem | null;
  onClear?: () => void;
};

const inferKind = (item: MediaItem | null) => {
  if (!item) {
    return "none";
  }
  const mime = item.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }

  const source = (item.url ?? item.localPath ?? "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(source)) {
    return "image";
  }
  if (/\.(mp4|webm|mov|mkv|avi)$/.test(source)) {
    return "video";
  }
  if (/\.(mp3|wav|m4a|ogg|flac)$/.test(source)) {
    return "audio";
  }
  return "unknown";
};

const toFileUrl = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(prefixed)}`;
};

const getSourceUrl = (item: MediaItem) => {
  if (item.url) {
    return item.url;
  }
  if (item.localPath) {
    return toFileUrl(item.localPath);
  }
  return "";
};

export const MediaViewer = ({ item, onClear }: Props) => {
  if (!item) {
    return (
      <div className="media-empty">
        <div className="media-empty-title">Media Viewer</div>
        <div className="media-empty-body">
          Select an attachment to preview here.
        </div>
      </div>
    );
  }

  const sourceUrl = getSourceUrl(item);
  const kind = inferKind(item);

  return (
    <div className="media-viewer">
      <div className="media-header">
        <div className="media-title">{item.label ?? "Media Viewer"}</div>
        {onClear ? (
          <button className="ghost-button" type="button" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="media-body">
        {kind === "image" ? (
          <img className="media-image" src={sourceUrl} alt={item.label ?? "Media"} />
        ) : null}
        {kind === "video" ? (
          <video className="media-video" src={sourceUrl} controls />
        ) : null}
        {kind === "audio" ? (
          <audio className="media-audio" src={sourceUrl} controls />
        ) : null}
        {kind === "unknown" ? (
          <div className="media-unknown">
            <div>Unsupported media type.</div>
            {sourceUrl ? (
              <a className="media-link" href={sourceUrl} target="_blank" rel="noreferrer">
                Open source
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export type { MediaItem };
