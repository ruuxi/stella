/**
 * Catalog of curated external apps Stella can open file artifacts with.
 *
 * Used by the main process to probe app availability and execute opens,
 * and by the renderer to type the IPC response. The actual probing /
 * launching lives in `desktop/electron/ipc/external-opener-handlers.ts`.
 */

export type ExternalOpenerKind =
  | "app" // launch with a named external application
  | "default" // open with the OS-default handler
  | "reveal"; // reveal in Finder / Explorer

export type ExternalOpener = {
  id: string;
  label: string;
  kind: ExternalOpenerKind;
};

/**
 * Canonical set of "developer / source code" file extensions used by
 * both the chat surface (to decide whether an edited path should
 * surface a Code changes pill via `path-to-viewer.ts`) and the
 * external-opener catalog (to decide which editors to offer).
 *
 * Keep additions language-agnostic — anything a code editor like
 * Cursor / VS Code / Zed can meaningfully open belongs here.
 */
export const DEVELOPER_EXTS = [
  // C / C++ / Objective-C
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "m",
  "mm",
  // .NET
  "cs",
  "fs",
  "vb",
  // Web / frontend
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",
  // JS / TS
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  // JVM
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "clj",
  "cljs",
  // Apple
  "swift",
  // Systems
  "rs",
  "go",
  "zig",
  "nim",
  // Scripting
  "py",
  "rb",
  "pl",
  "lua",
  "r",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  // Config / data
  "json",
  "json5",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "csv",
  "tsv",
  // Query / schema
  "sql",
  "graphql",
  "gql",
  "proto",
  // Text-ish
  "txt",
  "md",
  "mdx",
  "log",
  "diff",
  "patch",
  "lock",
  "dockerfile",
  "makefile",
  // Other languages people often edit
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "elm",
  "dart",
  "tf",
  "hcl",
  "sol",
];

/** Alias kept for the opener catalog's `extensions:` field naming. */
export const CODE_EXTS = DEVELOPER_EXTS;

export const SLIDE_EXTS = ["key", "pptx", "ppt"];
export const DOC_EXTS = ["pages", "docx", "doc", "rtf", "odt"];
export const SHEET_EXTS = ["numbers", "xlsx", "xls", "ods"];
export const PDF_EXTS = ["pdf"];
export const IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "svg",
  "ico",
];
export const VIDEO_EXTS = [
  "mp4",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
];
export const AUDIO_EXTS = [
  "mp3",
  "wav",
  "aac",
  "flac",
  "ogg",
  "oga",
  "m4a",
  "aiff",
  "aif",
  "opus",
  "wma",
];
export const HTML_EXTS = ["html", "htm", "xhtml"];
/** Files browsers can preview reasonably well (images, PDFs, HTML, SVG). */
export const BROWSER_EXTS = [...IMAGE_EXTS, ...PDF_EXTS, ...HTML_EXTS];

export const extOf = (filePath: string): string => {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return base.toLowerCase();
  }
  return base.slice(dot + 1).toLowerCase();
};
