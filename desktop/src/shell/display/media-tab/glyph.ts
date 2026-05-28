import {
  Box,
  FileDown,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  type LucideIcon,
} from "lucide-react";
import type { MediaTabItem } from "./media-actions";

export const glyphForMediaItem = (
  item: MediaTabItem,
): { Icon: LucideIcon; label: string; badge?: string } => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths.length > 1
        ? { Icon: ImageIcon, label: "Photos", badge: String(item.asset.filePaths.length) }
        : { Icon: ImageIcon, label: "Photo" };
    case "video":
      return { Icon: Film, label: "Video" };
    case "audio":
      return { Icon: Music, label: "Audio" };
    case "model3d":
      return { Icon: Box, label: "3D" };
    case "download":
      return { Icon: FileDown, label: "File" };
    case "text":
      return { Icon: FileText, label: "Text" };
  }
};
