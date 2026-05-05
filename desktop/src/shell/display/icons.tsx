/**
 * File-type icons for the Display tab strip and the inline chat
 * end-resource pill.
 *
 * Each icon is a custom SVG built around a shared "folded sheet" silhouette,
 * with a type-specific colored badge or glyph painted on top. The sheet
 * outline tracks `currentColor` so it adapts to the surrounding text colour
 * in either theme; the badge colours are intentionally fixed brand-style
 * accents (PDF red, sheet green, slides orange, etc.) so each format is
 * recognizable at a glance.
 *
 * Inline SVG keeps the icon set self-contained — we avoid pulling in a full
 * icon dependency just for ~10 glyphs.
 */

import type { CSSProperties, ReactNode } from "react";
import type { DisplayTabKind } from "./types";

const TYPE_COLORS = {
  pdf: "#dc2626",
  doc: "#2563eb",
  sheet: "#16a34a",
  slides: "#ea580c",
  markdown: "#2563eb",
  diff: "#16a34a",
  image: "#7c3aed",
  video: "#e11d48",
  audio: "#9333ea",
  model3d: "#0ea5e9",
  download: "#0d9488",
  text: "#64748b",
} as const;

type IconProps = {
  size?: number;
  style?: CSSProperties;
};

const Sheet = ({
  size = 18,
  style,
  children,
}: IconProps & { children: ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    <path
      d="M6 2.5h7.6L18.5 7.5v12.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2z"
      fill="currentColor"
      fillOpacity="0.07"
    />
    <path
      d="M6 2.5h7.6L18.5 7.5v12.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2z"
      stroke="currentColor"
      strokeOpacity="0.32"
      strokeWidth="1"
    />
    <path
      d="M13.5 2.5v5h5"
      stroke="currentColor"
      strokeOpacity="0.32"
      strokeWidth="1"
      fill="none"
      strokeLinejoin="round"
    />
    {children}
  </svg>
);

const TypeBadge = ({ color, label }: { color: string; label: string }) => (
  <>
    <rect x="5" y="13.2" width="12" height="6" rx="1.4" fill={color} />
    <text
      x="11"
      y="17.6"
      textAnchor="middle"
      fontSize="3.9"
      fontWeight="700"
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fill="#fff"
      letterSpacing="0.04em"
    >
      {label}
    </text>
  </>
);

const PdfIcon = (props: IconProps) => (
  <Sheet {...props}>
    <TypeBadge color={TYPE_COLORS.pdf} label="PDF" />
  </Sheet>
);

const DocumentIcon = (props: IconProps) => (
  <Sheet {...props}>
    <TypeBadge color={TYPE_COLORS.doc} label="DOC" />
  </Sheet>
);

const SheetIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g transform="translate(5 11.2)" fill={TYPE_COLORS.sheet}>
      <rect x="0" y="0" width="12" height="8" rx="1.2" />
      <rect
        x="0"
        y="0"
        width="12"
        height="2.4"
        fill="#fff"
        fillOpacity="0.55"
      />
      <line
        x1="4"
        y1="0"
        x2="4"
        y2="8"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="0.7"
      />
      <line
        x1="8"
        y1="0"
        x2="8"
        y2="8"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="0.7"
      />
      <line
        x1="0"
        y1="2.4"
        x2="12"
        y2="2.4"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="0.7"
      />
      <line
        x1="0"
        y1="5.2"
        x2="12"
        y2="5.2"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="0.7"
      />
    </g>
  </Sheet>
);

const SlidesIcon = (props: IconProps) => (
  <Sheet {...props}>
    <TypeBadge color={TYPE_COLORS.slides} label="PPT" />
  </Sheet>
);

const ImageIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g transform="translate(5 11.2)">
      <rect
        x="0"
        y="0"
        width="12"
        height="8.6"
        rx="1.2"
        fill={TYPE_COLORS.image}
        fillOpacity="0.18"
        stroke={TYPE_COLORS.image}
        strokeWidth="1"
      />
      <circle cx="3" cy="2.8" r="1" fill={TYPE_COLORS.image} />
      <path
        d="M0.6 7.6L3.8 4.4L6.4 6.4L8.8 3.8L11.4 7.6"
        stroke={TYPE_COLORS.image}
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </g>
  </Sheet>
);

const VideoIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g transform="translate(5 11.5)">
      <rect
        x="0"
        y="0"
        width="12"
        height="8.5"
        rx="1.4"
        fill={TYPE_COLORS.video}
      />
      <path d="M4.7 2.4L8.7 4.25L4.7 6.1Z" fill="#fff" />
    </g>
  </Sheet>
);

const AudioIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g
      transform="translate(5 11.4)"
      stroke={TYPE_COLORS.audio}
      strokeWidth="1.4"
      strokeLinecap="round"
      fill="none"
    >
      <path d="M4.4 0.6V7" />
      <path d="M4.4 0.6L10 -0.2V6" />
      <circle cx="2.8" cy="7" r="1.5" fill={TYPE_COLORS.audio} stroke="none" />
      <circle cx="8.4" cy="6" r="1.5" fill={TYPE_COLORS.audio} stroke="none" />
    </g>
  </Sheet>
);

const Model3dIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g
      transform="translate(5 11.4)"
      stroke={TYPE_COLORS.model3d}
      strokeWidth="1.1"
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
    >
      <path
        d="M6 0L11.6 3V8L6 11L0.4 8V3Z"
        fill={TYPE_COLORS.model3d}
        fillOpacity="0.15"
      />
      <path d="M6 5.5L11.6 3" />
      <path d="M6 5.5V11" />
      <path d="M6 5.5L0.4 3" />
    </g>
  </Sheet>
);

const DownloadIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g
      transform="translate(5 11.6)"
      stroke={TYPE_COLORS.download}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M6 0V6.2" />
      <path d="M3.4 4L6 6.7L8.6 4" />
      <path d="M0.5 8.4H11.5" />
    </g>
  </Sheet>
);

const TextIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g
      transform="translate(5 11.6)"
      stroke={TYPE_COLORS.text}
      strokeWidth="1.3"
      strokeLinecap="round"
      fill="none"
    >
      <path d="M0.5 0.6H11.5" />
      <path d="M0.5 4H11.5" />
      <path d="M0.5 7.4H7.5" />
    </g>
  </Sheet>
);

const MarkdownIcon = (props: IconProps) => (
  <Sheet {...props}>
    <TypeBadge color={TYPE_COLORS.markdown} label="MD" />
  </Sheet>
);

const DiffIcon = (props: IconProps) => (
  <Sheet {...props}>
    <g
      transform="translate(5 11.6)"
      stroke={TYPE_COLORS.diff}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M1 2H11" />
      <path d="M1 6H11" />
      <path d="M3 0V4" />
      <path d="M5 2H1" />
      <path d="M7 6H11" />
    </g>
  </Sheet>
);

const StoreIcon = ({ size = 18, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    {/* Shopping bag silhouette — matches the sidebar's `CustomStore` mark
        so the display tab reads as "the same thing as Store" at a glance. */}
    <path
      d="M6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8z"
      stroke="currentColor"
      strokeOpacity="0.75"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.08"
    />
    <path
      d="M9 8V6a3 3 0 0 1 6 0v2"
      stroke="currentColor"
      strokeOpacity="0.75"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

/**
 * Media tab icon — minimalist Photos-style silhouette in currentColor.
 * Matches the chrome of the other top-level tab icons (Chat, Store,
 * Trash) instead of the badged `ImageIcon` used for inline image
 * payloads.
 */
const MediaIcon = ({ size = 18, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    <rect
      x="3.5"
      y="5.5"
      width="17"
      height="13"
      rx="2.5"
      stroke="currentColor"
      strokeOpacity="0.75"
      strokeWidth="1.5"
      fill="currentColor"
      fillOpacity="0.08"
    />
    <circle cx="9" cy="10" r="1.4" fill="currentColor" fillOpacity="0.75" />
    <path
      d="M5 16.5l4-4 3.5 3 3-2.5 3.5 3.5"
      stroke="currentColor"
      strokeOpacity="0.75"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

const ChatIcon = ({ size = 18, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    <path
      d="M5 5.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"
      stroke="currentColor"
      strokeOpacity="0.7"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.08"
    />
  </svg>
);

const TrashIcon = ({ size = 18, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    <path
      d="M5 7h14M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M7 7l1 12.2a2 2 0 0 0 2 1.8h4a2 2 0 0 0 2-1.8L17 7"
      stroke="currentColor"
      strokeOpacity="0.75"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.08"
    />
    <path
      d="M10.5 10.5v6M13.5 10.5v6"
      stroke="currentColor"
      strokeOpacity="0.55"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

const UrlIcon = ({ size = 18, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="8"
      stroke="currentColor"
      strokeOpacity="0.7"
      strokeWidth="1.5"
      fill="currentColor"
      fillOpacity="0.08"
    />
    <path
      d="M4 12h16M12 4c2.5 2.5 3.8 5.4 3.8 8s-1.3 5.5-3.8 8M12 4c-2.5 2.5-3.8 5.4-3.8 8s1.3 5.5 3.8 8"
      stroke="currentColor"
      strokeOpacity="0.7"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const DisplayTabIcon = ({
  kind,
  size,
  style,
}: {
  kind: DisplayTabKind;
  size?: number;
  style?: CSSProperties;
}) => {
  switch (kind) {
    case "chat":
      return <ChatIcon size={size} style={style} />;
    case "image":
      return <ImageIcon size={size} style={style} />;
    case "media":
      return <MediaIcon size={size} style={style} />;
    case "pdf":
      return <PdfIcon size={size} style={style} />;
    case "office-spreadsheet":
      return <SheetIcon size={size} style={style} />;
    case "office-document":
      return <DocumentIcon size={size} style={style} />;
    case "office-slides":
      return <SlidesIcon size={size} style={style} />;
    case "url":
      return <UrlIcon size={size} style={style} />;
    case "markdown":
      return <MarkdownIcon size={size} style={style} />;
    case "source-diff":
      return <DiffIcon size={size} style={style} />;
    case "video":
      return <VideoIcon size={size} style={style} />;
    case "audio":
      return <AudioIcon size={size} style={style} />;
    case "model3d":
      return <Model3dIcon size={size} style={style} />;
    case "download":
      return <DownloadIcon size={size} style={style} />;
    case "text":
      return <TextIcon size={size} style={style} />;
    case "store":
      return <StoreIcon size={size} style={style} />;
    case "trash":
      return <TrashIcon size={size} style={style} />;
  }
};
