/**
 * Inline clickable rendering for `stella://file/...` references in
 * assistant chat text.
 *
 * Renders as ordinary underlined link text inside the sentence — no chip
 * or card chrome — matching how a normal hyperlink reads. Clicking opens
 * the file in the matching workspace-panel viewer (canvas for HTML,
 * media/PDF/markdown/office viewers for those types) via the same
 * `openDisplayPayloadTab` path the end-resource pill uses; types with no
 * in-app viewer fall back to the OS-default app.
 *
 * The element arrives from `remarkStellaFileLinks` as a custom
 * `<stella-file path label>` node, so no real `href` ever exists — an
 * href-less `<a role="button">` avoids both navigation and the
 * bubble-highlight regression documented in `Markdown.tsx`.
 */

import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import { displayPayloadForStellaFile } from "@/features/chat/lib/stella-file-links";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";

type StellaFileLinkProps = {
  path?: unknown;
  label?: unknown;
  node?: unknown;
};

export const StellaFileLink = ({ path, label }: StellaFileLinkProps) => {
  const [failed, setFailed] = useState(false);
  const filePath = typeof path === "string" ? path : "";
  const rawLabel = typeof label === "string" ? label.trim() : "";
  const display = rawLabel || (filePath ? basenameOf(filePath) : "");

  const open = useCallback(() => {
    if (!filePath) return;
    setFailed(false);
    const payload = displayPayloadForStellaFile(filePath, Date.now());
    if (payload) {
      openDisplayPayloadTab(payload);
      return;
    }
    // No in-app viewer for this type — hand it to the OS default app.
    // `openPath` reports missing/unopenable files as `ok: false`.
    const api = window.electronAPI?.system;
    if (!api?.openPath) {
      setFailed(true);
      return;
    }
    void api
      .openPath(filePath)
      .then((result) => {
        if (!result?.ok) setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [filePath]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    },
    [open],
  );

  // A reference the remark plugin let through without a usable path
  // degrades to plain text instead of a dead control.
  if (!filePath || !display) {
    return <span>{display || null}</span>;
  }

  return (
    <a
      role="button"
      tabIndex={0}
      className="markdown-stella-file"
      data-failed={failed || undefined}
      title={failed ? `Couldn't open ${filePath}` : filePath}
      onClick={open}
      onKeyDown={handleKeyDown}
    >
      {display}
    </a>
  );
};
