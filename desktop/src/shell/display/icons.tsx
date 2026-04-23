/**
 * Tiny inline icons for tabs and resource pills. Inline SVG so we don't
 * pull a whole icon set just for ~10 glyphs.
 */

import type { CSSProperties } from "react";
import type { DisplayTabKind } from "./types";

const baseProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ImageIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

const PdfIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <text x="7.5" y="17.5" fontSize="6.5" fontWeight="700" stroke="none" fill="currentColor">PDF</text>
  </svg>
);

const SheetIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);

const DocumentIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h6" />
  </svg>
);

const SlidesIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M9 21h6M12 18v3" />
  </svg>
);

const HtmlIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M4 4h16v16H4z" />
    <path d="M9 9l-2 3 2 3M15 9l2 3-2 3" />
  </svg>
);

const VideoIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3z" />
  </svg>
);

const AudioIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M9 17V5l10-2v12" />
    <circle cx="6" cy="17" r="3" />
    <circle cx="16" cy="15" r="3" />
  </svg>
);

const Model3dIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M12 2l9 5v10l-9 5-9-5V7z" />
    <path d="M12 12l9-5M12 12v10M12 12L3 7" />
  </svg>
);

const DownloadIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

const TextIcon = (props: { style?: CSSProperties }) => (
  <svg {...baseProps} style={props.style}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);

export const DisplayTabIcon = ({
  kind,
  style,
}: {
  kind: DisplayTabKind;
  style?: CSSProperties;
}) => {
  switch (kind) {
    case "image":
      return <ImageIcon style={style} />;
    case "pdf":
      return <PdfIcon style={style} />;
    case "office-spreadsheet":
      return <SheetIcon style={style} />;
    case "office-document":
      return <DocumentIcon style={style} />;
    case "office-slides":
      return <SlidesIcon style={style} />;
    case "html":
      return <HtmlIcon style={style} />;
    case "video":
      return <VideoIcon style={style} />;
    case "audio":
      return <AudioIcon style={style} />;
    case "model3d":
      return <Model3dIcon style={style} />;
    case "download":
      return <DownloadIcon style={style} />;
    case "text":
      return <TextIcon style={style} />;
  }
};
