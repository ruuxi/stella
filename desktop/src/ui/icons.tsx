/**
 * Stella's hand-drawn icon set. Replaces lucide-react with original geometry:
 * 24x24 grid, stroke-based, rounded caps/joins, SF-Symbols-inspired optical
 * insets. Components keep lucide's prop surface (size / strokeWidth / SVG
 * props) so they remain drop-in at every call site.
 */
import { forwardRef } from "react";
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

export type IconComponent = ReturnType<typeof createIcon>;

function createIcon(name: string, children: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function StellaIcon(
    { size = 24, strokeWidth = 2, className, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `stella-icon stella-icon-${name} ${className}` : `stella-icon stella-icon-${name}`}
        {...rest}
      >
        {children}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

/* ---------------------------------- core --------------------------------- */

export const X = createIcon("x", <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);

export const Check = createIcon("check", <path d="M5 12.8 9.9 17.7 19 7.3" />);

export const Plus = createIcon("plus", <path d="M12 5.5v13M5.5 12h13" />);

export const Minus = createIcon("minus", <path d="M5.5 12h13" />);

export const MoreHorizontal = createIcon(
  "more-horizontal",
  <>
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>,
);

export const Search = createIcon(
  "search",
  <>
    <circle cx="10.75" cy="10.75" r="6.25" />
    <path d="M15.5 15.5 20.5 20.5" />
  </>,
);

export const LoaderCircle = createIcon("loader-circle", <path d="M20.25 12A8.25 8.25 0 1 1 12 3.75" />);

export const Circle = createIcon("circle", <circle cx="12" cy="12" r="8.25" />);

export const CircleDot = createIcon(
  "circle-dot",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </>,
);

export const AlertCircle = createIcon(
  "alert-circle",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 7.75v5M12 16.25h.01" />
  </>,
);

export const CheckCircle2 = createIcon(
  "check-circle",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="m8.4 12.3 2.5 2.5 4.7-5.3" />
  </>,
);

/* -------------------------------- chevrons ------------------------------- */

export const ChevronDown = createIcon("chevron-down", <path d="m6.5 9.25 5.5 5.5 5.5-5.5" />);
export const ChevronUp = createIcon("chevron-up", <path d="m6.5 14.75 5.5-5.5 5.5 5.5" />);
export const ChevronLeft = createIcon("chevron-left", <path d="m14.75 6.5-5.5 5.5 5.5 5.5" />);
export const ChevronRight = createIcon("chevron-right", <path d="m9.25 6.5 5.5 5.5-5.5 5.5" />);

/* --------------------------------- arrows -------------------------------- */

export const ArrowUp = createIcon("arrow-up", <path d="M12 19.5v-15M5.5 11 12 4.5 18.5 11" />);
export const ArrowDown = createIcon("arrow-down", <path d="M12 4.5v15M5.5 13l6.5 6.5L18.5 13" />);
export const ArrowLeft = createIcon("arrow-left", <path d="M19.5 12h-15M11 5.5 4.5 12l6.5 6.5" />);
export const ArrowRight = createIcon("arrow-right", <path d="M4.5 12h15M13 5.5 19.5 12 13 18.5" />);

export const Maximize2 = createIcon(
  "maximize-2",
  <path d="M14 4.5h5.5V10M19.25 4.75 13.5 10.5M10 19.5H4.5V14M4.75 19.25 10.5 13.5" />,
);

export const Minimize2 = createIcon(
  "minimize-2",
  <path d="M19.5 10H14V4.5M19.25 4.75 14.5 9.5M4.5 14H10v5.5M4.75 19.25 9.5 14.5" />,
);

export const ExternalLink = createIcon(
  "external-link",
  <path d="M19.75 13.25v3.5a3 3 0 0 1-3 3H7.25a3 3 0 0 1-3-3V7.25a3 3 0 0 1 3-3h3.5M14.5 4.25h5.25V9.5M19.25 4.75 12.5 11.5" />,
);

export const RefreshCw = createIcon(
  "refresh-cw",
  <path d="M20.25 12A8.25 8.25 0 1 1 12 3.75c2.83 0 5.33 1.42 6.82 3.58M19.5 3.5v4h-4" />,
);

export const RotateCcw = createIcon(
  "rotate-ccw",
  <path d="M3.75 12A8.25 8.25 0 1 0 12 3.75c-2.83 0-5.33 1.42-6.82 3.58M4.5 3.5v4h4" />,
);

export const History = createIcon(
  "history",
  <>
    <path d="M12 3.75a8.25 8.25 0 1 1-8.18 9.31" />
    <path d="M4.75 4.75v4h4" />
    <path d="M12 8.25V12l2.6 1.7" />
  </>,
);

export const Download = createIcon(
  "download",
  <path d="M4.5 14.25v3.25a2.75 2.75 0 0 0 2.75 2.75h9.5a2.75 2.75 0 0 0 2.75-2.75v-3.25M12 3.75v10M7.75 9.75 12 14l4.25-4.25" />,
);

export const Upload = createIcon(
  "upload",
  <path d="M4.5 14.25v3.25a2.75 2.75 0 0 0 2.75 2.75h9.5a2.75 2.75 0 0 0 2.75-2.75v-3.25M12 14.5V4M7.75 8.25 12 4l4.25 4.25" />,
);

export const LogIn = createIcon(
  "log-in",
  <path d="M13.5 4.25h3.25a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3H13.5M4 12h9.25M9.75 8.5 13.25 12l-3.5 3.5" />,
);

export const LogOut = createIcon(
  "log-out",
  <path d="M10.5 4.25H7.25a3 3 0 0 0-3 3v9.5a3 3 0 0 0 3 3h3.25M9.5 12H20M16.5 8.5 20 12l-3.5 3.5" />,
);

export const Send = createIcon(
  "send",
  <>
    <path d="M19.23 3.6 4 9.26c-.96.36-.93 1.71.04 2.02l5.8 1.83c.34.11.6.37.71.71l1.83 5.8c.31.97 1.66 1 2.02.04L20.06 4.43a.64.64 0 0 0-.83-.83Z" />
    <path d="m10.16 13.84 4.4-4.4" />
  </>,
);

/* ------------------------------ communication ---------------------------- */

const bubblePath =
  "M12 4.5c-4.69 0-8.5 3.13-8.5 7 0 2.13 1.16 4.04 2.99 5.32-.18 1.21-.74 2.34-1.6 3.21a7.66 7.66 0 0 0 4.27-1.69c.88.27 1.83.41 2.84.41 4.69 0 8.5-3.13 8.5-7.25S16.69 4.5 12 4.5Z";

export const MessageSquare = createIcon("message", <path d={bubblePath} />);

export const MessageSquarePlus = createIcon(
  "message-plus",
  <>
    <path d={bubblePath} />
    <path d="M12 8.75v5M9.5 11.25h5" />
  </>,
);

export const Phone = createIcon(
  "phone",
  <path d="M7.6 4.1c.62-.62 1.64-.56 2.2.12l1.55 1.93c.46.57.46 1.39 0 1.96l-1 1.27a.94.94 0 0 0-.07 1.1 13.1 13.1 0 0 0 3.64 3.64c.34.23.8.2 1.1-.07l1.27-1a1.56 1.56 0 0 1 1.96 0l1.93 1.55c.68.56.74 1.58.12 2.2l-1.05 1.05c-.9.9-2.24 1.23-3.44.77-2.52-.97-4.9-2.5-6.9-4.5s-3.53-4.38-4.5-6.9c-.46-1.2-.13-2.54.77-3.44Z" />,
);

export const Smartphone = createIcon(
  "smartphone",
  <>
    <rect x="6.75" y="3.25" width="10.5" height="17.5" rx="3" />
    <path d="M10.5 17.5h3" />
  </>,
);

/* --------------------------------- media --------------------------------- */

export const Play = createIcon(
  "play",
  <path d="M8.25 5.6v12.8c0 .87.96 1.4 1.7.93l10.06-6.4a1.1 1.1 0 0 0 0-1.86L9.95 4.67c-.74-.47-1.7.06-1.7.93Z" />,
);

export const Pause = createIcon("pause", <path d="M9.25 5.5v13M14.75 5.5v13" />);

export const Square = createIcon("square", <rect x="5.75" y="5.75" width="12.5" height="12.5" rx="2.5" />);

export const Mic = createIcon(
  "mic",
  <>
    <rect x="9.25" y="3" width="5.5" height="11" rx="2.75" />
    <path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75V21" />
  </>,
);

export const AudioLines = createIcon(
  "audio-lines",
  <path d="M4.5 10.5v3M8.25 7.5v9M12 4.5v15M15.75 8.5v7M19.5 10.5v3" />,
);

export const Volume2 = createIcon(
  "volume-2",
  <>
    <path d="M11.5 5.6 7.4 9.25H4.9A1.9 1.9 0 0 0 3 11.15v1.7a1.9 1.9 0 0 0 1.9 1.9h2.5l4.1 3.65c.65.53 1.5.06 1.5-.78V6.38c0-.84-.85-1.31-1.5-.78Z" />
    <path d="M16 9.5a4.4 4.4 0 0 1 0 5M18.5 7.25a7.9 7.9 0 0 1 0 9.5" />
  </>,
);

export const Music = createIcon(
  "music",
  <>
    <path d="M9.75 17.4V6.5l9.5-1.9v10.9" />
    <circle cx="7" cy="17.4" r="2.75" />
    <circle cx="16.5" cy="15.5" r="2.75" />
  </>,
);

export const Camera = createIcon(
  "camera",
  <>
    <path d="M8.4 6.5l.74-1.48A2 2 0 0 1 10.93 4h2.14a2 2 0 0 1 1.79 1.02L15.6 6.5h1.9a3 3 0 0 1 3 3v7.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V9.5a3 3 0 0 1 3-3Z" />
    <circle cx="12" cy="13" r="3.25" />
  </>,
);

export const Image = createIcon(
  "image",
  <>
    <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3" />
    <circle cx="9" cy="9.75" r="1.6" />
    <path d="m5.1 18.5 5.04-5.04a1.75 1.75 0 0 1 2.47 0l5.64 5.54" />
    <path d="m15.5 15.25 1.2-1.2a1.75 1.75 0 0 1 2.47 0l1.08 1.08" />
  </>,
);

export const Film = createIcon(
  "film",
  <>
    <rect x="4.25" y="3.75" width="15.5" height="16.5" rx="3" />
    <path d="M8.25 3.75v16.5M15.75 3.75v16.5M4.25 8h4M4.25 12h4M4.25 16h4M15.75 8h4M15.75 12h4M15.75 16h4" />
  </>,
);

export const Video = createIcon(
  "video",
  <>
    <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3" />
    <path d="m10.2 9.1 4.5 2.9-4.5 2.9Z" />
  </>,
);

export const Crop = createIcon(
  "crop",
  <path d="M6.5 2.5V14A3.5 3.5 0 0 0 10 17.5h11.5M2.5 6.5H14A3.5 3.5 0 0 1 17.5 10v11.5" />,
);

export const Scan = createIcon(
  "scan",
  <path d="M8.5 4.25H7A2.75 2.75 0 0 0 4.25 7v1.5M15.5 4.25H17A2.75 2.75 0 0 1 19.75 7v1.5M8.5 19.75H7A2.75 2.75 0 0 1 4.25 17v-1.5M15.5 19.75H17A2.75 2.75 0 0 0 19.75 17v-1.5" />,
);

/* -------------------------------- documents ------------------------------ */

const filePaths = (
  <>
    <path d="M13.25 3.75H8A2.75 2.75 0 0 0 5.25 6.5v11A2.75 2.75 0 0 0 8 20.25h8a2.75 2.75 0 0 0 2.75-2.75V9.25Z" />
    <path d="M13.25 3.75V7.5A1.75 1.75 0 0 0 15 9.25h3.75" />
  </>
);

export const File = createIcon("file", filePaths);

export const FileText = createIcon(
  "file-text",
  <>
    {filePaths}
    <path d="M8.75 13h6.5M8.75 16.5h4.25" />
  </>,
);

export const FileSpreadsheet = createIcon(
  "file-spreadsheet",
  <>
    {filePaths}
    <path d="M8.75 12.75h6.5M8.75 16.25h6.5M12 12.75v3.5" />
  </>,
);

export const FileDown = createIcon(
  "file-down",
  <>
    {filePaths}
    <path d="M12 11.75v5M9.75 14.5 12 16.75l2.25-2.25" />
  </>,
);

export const Folder = createIcon(
  "folder",
  <path d="M3.75 7A2.75 2.75 0 0 1 6.5 4.25h2.9c.73 0 1.42.32 1.9.88l.9 1.06c.28.34.7.53 1.14.53h4.16a2.75 2.75 0 0 1 2.75 2.78v8A2.75 2.75 0 0 1 17.5 20.25h-11A2.75 2.75 0 0 1 3.75 17.5Z" />,
);

export const FolderOpen = createIcon(
  "folder-open",
  <>
    <path d="M3.75 17V7A2.75 2.75 0 0 1 6.5 4.25h2.9c.73 0 1.42.32 1.9.88l.9 1.06c.28.34.7.53 1.14.53h3.41a2.5 2.5 0 0 1 2.5 2.53v1" />
    <path d="m3.78 17.6 2.2-4.77A2.25 2.25 0 0 1 8.03 11.5h12.04c1.1 0 1.83 1.14 1.37 2.14l-1.97 4.27a2.75 2.75 0 0 1-2.5 1.59H6.5a2.75 2.75 0 0 1-2.72-2.9Z" />
  </>,
);

export const Copy = createIcon(
  "copy",
  <>
    <rect x="8.75" y="8.75" width="11" height="11" rx="3" />
    <path d="M5.25 15V7.5a3.25 3.25 0 0 1 3.25-3.25H15" />
  </>,
);

export const ClipboardList = createIcon(
  "clipboard-list",
  <>
    <path d="M8.5 4.5H8a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-10a3 3 0 0 0-3-3h-.5" />
    <rect x="9" y="2.75" width="6" height="3.5" rx="1.75" />
    <path d="M9 11.25h6M9 15.25h4" />
  </>,
);

export const ClipboardPaste = createIcon(
  "clipboard-paste",
  <>
    <path d="M8.5 4.5H8a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-10a3 3 0 0 0-3-3h-.5" />
    <rect x="9" y="2.75" width="6" height="3.5" rx="1.75" />
    <path d="M12 9.75v6.5M9.5 13.75 12 16.25l2.5-2.5" />
  </>,
);

export const Archive = createIcon(
  "archive",
  <>
    <rect x="3.5" y="4.25" width="17" height="5" rx="1.75" />
    <path d="M5 9.25v8.25a2.75 2.75 0 0 0 2.75 2.75h8.5A2.75 2.75 0 0 0 19 17.5V9.25M10 13h4" />
  </>,
);

export const Code = createIcon("code", <path d="m15.5 7.25 5 4.75-5 4.75M8.5 7.25 3.5 12l5 4.75" />);

export const Presentation = createIcon(
  "presentation",
  <>
    <path d="M3.5 4.25h17" />
    <path d="M5.25 4.25h13.5V13.5a3 3 0 0 1-3 3h-7.5a3 3 0 0 1-3-3Z" />
    <path d="m8.5 20.5 3.5-3 3.5 3" />
  </>,
);

export const CreditCard = createIcon(
  "credit-card",
  <>
    <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3" />
    <path d="M3.25 9.75h17.5M6.75 14.75h3.5" />
  </>,
);

/* --------------------------------- people -------------------------------- */

export const User = createIcon(
  "user",
  <>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M5 19.9c.95-3.6 3.8-5.65 7-5.65s6.05 2.05 7 5.65" />
  </>,
);

export const Users = createIcon(
  "users",
  <>
    <circle cx="9.25" cy="8.25" r="3.5" />
    <path d="M3 19.7c.85-3.3 3.4-5.2 6.25-5.2s5.4 1.9 6.25 5.2" />
    <path d="M15.5 5.1a3.5 3.5 0 0 1 0 6.3M17.6 14.9c1.7.75 2.95 2.4 3.4 4.8" />
  </>,
);

export const UserPlus = createIcon(
  "user-plus",
  <>
    <circle cx="10" cy="8" r="3.75" />
    <path d="M3.25 19.9c.9-3.55 3.65-5.65 6.75-5.65 1.39 0 2.7.42 3.82 1.2" />
    <path d="M18.5 11.75v6M15.5 14.75h6" />
  </>,
);

/* ---------------------------------- tools -------------------------------- */

export const Pencil = createIcon(
  "pencil",
  <>
    <path d="m9.3 18.2 9.9-9.9a2.33 2.33 0 0 0-3.3-3.3l-9.9 9.9a2.5 2.5 0 0 0-.66 1.18L4.5 19.5l3.62-.84a2.5 2.5 0 0 0 1.18-.46Z" />
    <path d="m13.5 7.4 3.1 3.1" />
  </>,
);

export const SquarePen = createIcon(
  "square-pen",
  <>
    <path d="M11.5 4.75H7.25a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V12.5" />
    <path d="M18.2 3.85a2.1 2.1 0 0 1 2.97 2.97l-7.4 7.4-3.87.9.9-3.87Z" />
  </>,
);

export const Trash2 = createIcon(
  "trash-2",
  <>
    <path d="M4.75 6.5h14.5M9.5 6.5V5.25A1.75 1.75 0 0 1 11.25 3.5h1.5a1.75 1.75 0 0 1 1.75 1.75V6.5" />
    <path d="m6.25 6.5.74 11.43a2.5 2.5 0 0 0 2.49 2.32h5.04a2.5 2.5 0 0 0 2.49-2.32L17.75 6.5" />
    <path d="M10 10.25v6.25M14 10.25v6.25" />
  </>,
);

export const Paperclip = createIcon(
  "paperclip",
  <path d="m20.2 11.1-7.48 7.48a4.55 4.55 0 0 1-6.43-6.43l7.48-7.48a3.03 3.03 0 0 1 4.29 4.29l-7.13 7.13a1.52 1.52 0 0 1-2.14-2.14l6.77-6.78" />,
);

export const KeyRound = createIcon(
  "key-round",
  <>
    <circle cx="7.75" cy="16.25" r="3.75" />
    <path d="m10.5 13.5 9-9M15.25 8.75 18.5 12" />
  </>,
);

export const Lock = createIcon(
  "lock",
  <>
    <rect x="4.75" y="10.5" width="14.5" height="9.75" rx="3" />
    <path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75" />
  </>,
);

export const Pin = createIcon(
  "pin",
  <>
    <path d="M8.95 3.5h6.1l-.75 5.45 2.65 2.6c.9.88.27 2.4-.99 2.4H7.04c-1.26 0-1.89-1.52-.99-2.4l2.65-2.6Z" />
    <path d="M12 13.95V20.5" />
  </>,
);

export const Wand2 = createIcon(
  "wand-2",
  <>
    <path d="m4.6 19.4 9.2-9.2M15.4 8.6l1.4-1.4" />
    <path d="M18.75 3v2.5M17.5 4.25H20M21 8.5h.01M14.75 2.75h.01" />
  </>,
);

export const SlidersHorizontal = createIcon(
  "sliders-horizontal",
  <>
    <path d="M3.5 5.5h8.75M16.75 5.5h3.75M3.5 12h2.25M10.25 12h10.25M3.5 18.5h10.75M18.75 18.5h1.75" />
    <circle cx="14.75" cy="5.5" r="2" />
    <circle cx="8.25" cy="12" r="2" />
    <circle cx="16.75" cy="18.5" r="2" />
  </>,
);

export const Settings = createIcon(
  "settings",
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </>,
);

/* --------------------------------- layout -------------------------------- */

export const PanelRight = createIcon(
  "panel-right",
  <>
    <rect x="3.25" y="4.75" width="17.5" height="14.5" rx="3" />
    <path d="M15.25 4.75v14.5" />
  </>,
);

export const PanelLeft = createIcon(
  "panel-left",
  <>
    <rect x="3.25" y="4.75" width="17.5" height="14.5" rx="3" />
    <path d="M8.75 4.75v14.5" />
  </>,
);

export const AppWindowMac = createIcon(
  "app-window",
  <>
    <rect x="3.25" y="4.75" width="17.5" height="14.5" rx="3" />
    <path d="M6.75 8.25h.01M9.75 8.25h.01M12.75 8.25h.01" />
  </>,
);

export const LayoutList = createIcon(
  "layout-list",
  <>
    <rect x="3.5" y="4.75" width="5.25" height="5.25" rx="1.75" />
    <rect x="3.5" y="14" width="5.25" height="5.25" rx="1.75" />
    <path d="M12.25 6.25h8.25M12.25 9h5.25M12.25 15.5h8.25M12.25 18.25h5.25" />
  </>,
);

/* ---------------------------------- misc --------------------------------- */

export const Clock = createIcon(
  "clock",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 7.5V12l3 2" />
  </>,
);

export const Store = createIcon(
  "store",
  <>
    <path d="M5.75 8.25h12.5l-.86 9.78a2.75 2.75 0 0 1-2.74 2.47H9.35a2.75 2.75 0 0 1-2.74-2.47Z" />
    <path d="M8.75 8.25V7a3.25 3.25 0 0 1 6.5 0v1.25" />
  </>,
);

export const Star = createIcon(
  "star",
  <path d="M12 3.5l2.35 5.26 5.73.61-4.28 3.87L17 18.88 12 16l-5 2.88 1.2-5.64-4.28-3.87 5.73-.61Z" />,
);

export const Lightbulb = createIcon(
  "lightbulb",
  <>
    <path d="M12 3.25A6.25 6.25 0 0 0 8.6 14.74c.69.45 1.15 1.2 1.15 2.02v.49h4.5v-.49c0-.82.46-1.57 1.15-2.02A6.25 6.25 0 0 0 12 3.25Z" />
    <path d="M10.25 20.5h3.5" />
  </>,
);

export const Globe = createIcon(
  "globe",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <ellipse cx="12" cy="12" rx="3.75" ry="8.25" />
    <path d="M4.1 9.25h15.8M4.1 14.75h15.8" />
  </>,
);

export const Compass = createIcon(
  "compass",
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="m15.2 8.8-1.74 4.34a1 1 0 0 1-.56.56L8.8 15.2l1.74-4.34a1 1 0 0 1 .56-.56Z" />
  </>,
);

export const Box = createIcon(
  "box",
  <>
    <path d="M20.25 16.18V7.82a2 2 0 0 0-1.03-1.75l-6.25-3.47a2 2 0 0 0-1.94 0L4.78 6.07a2 2 0 0 0-1.03 1.75v8.36a2 2 0 0 0 1.03 1.75l6.25 3.47a2 2 0 0 0 1.94 0l6.25-3.47a2 2 0 0 0 1.03-1.75Z" />
    <path d="m4 7.6 8 4.4 8-4.4M12 12v8.5" />
  </>,
);

export const Palette = createIcon(
  "palette",
  <>
    <path d="M12 3.75a8.25 8.25 0 1 0 0 16.5c1 0 1.66-.78 1.66-1.62 0-.43-.17-.8-.42-1.1-.24-.3-.39-.62-.39-1.03 0-.9.73-1.62 1.63-1.62h1.92a3.85 3.85 0 0 0 3.85-3.85c0-4.07-3.78-7.28-8.25-7.28Z" />
    <circle cx="7.6" cy="10.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="10.4" cy="7.1" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.2" cy="7.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="16.9" cy="9.9" r="1" fill="currentColor" stroke="none" />
  </>,
);
