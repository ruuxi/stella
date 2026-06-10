import { useMemo } from "react";
import { X } from "@/ui/icons";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import type { MediaTabItem } from "./media-actions";
import { glyphForMediaItem } from "./glyph";

export const AttachedChip = ({
  item,
  onRemove,
}: {
  item: MediaTabItem;
  onRemove: () => void;
}) => {
  const filePaths = useMemo(
    () => (item.asset.kind === "image" ? item.asset.filePaths.slice(0, 1) : []),
    [item],
  );
  const { files } = useDisplayFileBlobs(filePaths);
  const thumbUrl = files[0]?.url ?? null;
  const { Icon, label } = glyphForMediaItem(item);

  return (
    <span className="media-tab__attached" role="group">
      <span className="media-tab__attached-clip">
        {thumbUrl ? (
          <img className="media-tab__attached-thumb" src={thumbUrl} alt="" />
        ) : (
          <span className="media-tab__attached-glyph" aria-label={label}>
            <Icon size={13} strokeWidth={1.7} />
          </span>
        )}
      </span>
      <button
        type="button"
        className="media-tab__attached-x"
        onClick={onRemove}
        aria-label="Remove attached media"
        title="Remove"
      >
        <X size={11} strokeWidth={2.4} />
      </button>
    </span>
  );
};
