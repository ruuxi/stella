import { useMemo } from "react";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import type { MediaTabItem } from "./media-item";
import { glyphForMediaItem } from "./glyph";

export const MediaTile = ({
  item,
  active,
  onSelect,
  onOpen,
}: {
  item: MediaTabItem;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
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
  const { Icon, label, badge } = glyphForMediaItem(item);

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
      title={isMissing ? "File moved or deleted" : label}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-label={label}
      aria-pressed={active}
    >
      {thumbUrl ? (
        <img className="media-tab__tile-img" src={thumbUrl} alt="" />
      ) : (
        <span className="media-tab__tile-glyph">
          <Icon size={20} strokeWidth={1.6} />
        </span>
      )}
      {badge ? <span className="media-tab__tile-badge">{badge}</span> : null}
    </div>
  );
};
