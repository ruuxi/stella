import { useMemo } from "react";
import { Plus } from "lucide-react";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import type { MediaTabItem } from "./media-actions";
import { glyphForMediaItem } from "./glyph";

export const MediaTile = ({
  item,
  active,
  onSelect,
  onOpen,
  onAttach,
}: {
  item: MediaTabItem;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onAttach: () => void;
}) => {
  const filePaths = useMemo(
    () => (item.asset.kind === "image" ? item.asset.filePaths.slice(0, 1) : []),
    [item],
  );
  const { files, missing } = useDisplayFileBlobs(filePaths);
  const thumbUrl = files[0]?.url ?? null;
  const isPending =
    item.asset.kind === "image" && item.asset.filePaths.length === 0;
  const isMissing = (missing[0] ?? false) && !isPending;
  const { glyph, badge } = glyphForMediaItem(item);

  return (
    <div
      role="button"
      tabIndex={0}
      className={[
        "media-tab__tile",
        active ? "media-tab__tile--active" : null,
        isPending ? "media-tab__tile--pending" : null,
        isMissing ? "media-tab__tile--missing" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      title={isMissing ? "File moved or deleted" : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-label={glyph}
      aria-pressed={active}
    >
      {thumbUrl ? (
        <img className="media-tab__tile-img" src={thumbUrl} alt="" />
      ) : (
        <span className="media-tab__tile-glyph">{glyph}</span>
      )}
      {badge ? <span className="media-tab__tile-badge">{badge}</span> : null}
      <button
        type="button"
        className="media-tab__tile-attach"
        onClick={(event) => {
          event.stopPropagation();
          onAttach();
        }}
        aria-label="Use this media"
        title="Use this media"
      >
        <Plus size={12} strokeWidth={2.4} />
      </button>
    </div>
  );
};
