/**
 * Convert assistant markdown to TTS-friendly plain text.
 *
 * Removes things that sound terrible when read aloud (code fences,
 * URLs, raw markdown symbols) while preserving the natural prose. Not a
 * full markdown parser — just the strip-down a synthesizer needs.
 */
export function stripMarkdownForTts(input: string): string {
  if (!input) return "";
  let text = input;

  // Fenced code blocks — replace with a short spoken hint so the
  // assistant doesn't read curly braces and import statements aloud.
  text = text.replace(/```[a-zA-Z0-9]*\n?[\s\S]*?```/g, " (code block) ");
  // Inline code — drop the backticks but keep contents.
  text = text.replace(/`([^`]+)`/g, "$1");

  // Images: ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Links: [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Bare URLs.
  text = text.replace(/https?:\/\/\S+/g, " (link) ");

  // Headings (#, ##, …) — drop the leading hashes.
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Blockquote markers.
  text = text.replace(/^>\s?/gm, "");
  // Horizontal rules.
  text = text.replace(/^---+$/gm, "");

  // Emphasis: **bold**, __bold__, *italic*, _italic_ → bare text.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/(^|\s)_([^_\n]+)_/g, "$1$2");

  // List bullets: leading "- " / "* " / "1. ".
  text = text.replace(/^\s*[-*]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");

  // HTML tags — assistants occasionally emit `<br>` etc.
  text = text.replace(/<[^>]+>/g, "");

  // Collapse repeated whitespace and trim.
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  return text.trim();
}
