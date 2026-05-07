import type { MediaTabItem } from "./media-actions";

export const glyphForMediaItem = (
  item: MediaTabItem,
): { glyph: string; badge?: string } => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths.length > 1
        ? { glyph: "Photos", badge: String(item.asset.filePaths.length) }
        : { glyph: "Photo" };
    case "video":
      return { glyph: "Video" };
    case "audio":
      return { glyph: "Audio" };
    case "model3d":
      return { glyph: "3D" };
    case "download":
      return { glyph: "File" };
    case "text":
      return { glyph: "Text" };
  }
};
