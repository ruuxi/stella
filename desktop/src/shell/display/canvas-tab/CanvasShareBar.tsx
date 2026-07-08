/**
 * Share controls for the active canvas, overlaid on the canvas hero.
 *
 *  - Share button: publishes the selected canvas HTML to a public URL via
 *    the canvas-share backend, then shows the returned link with a
 *    copy-to-clipboard affordance and a lightweight confirmation.
 *  - Shared links: a small panel listing the account's active shares
 *    (`listMine`) with copy + revoke.
 *
 * The whole bar renders nothing when the canvas-share context is absent
 * (e.g. the mini window, which has no Convex provider), so the sandboxed
 * canvas renderer never reaches for Convex outside a provider.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Globe, LoaderCircle, Trash2 } from "@/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { showToast } from "@/ui/toast";
import {
  useCanvasShare,
  type PublishedCanvasShare,
  type SharedCanvasLink,
} from "@/features/canvas-share/canvas-share-context";
import type { CanvasHtmlItem } from "./canvas-items";
import "./canvas-share.css";

const decoder = new TextDecoder("utf-8");

type PublishStatus = "idle" | "publishing" | "done" | "error";

const readCanvasHtml = async (filePath: string): Promise<string> => {
  const readFile = window.electronAPI?.display?.readFile;
  if (typeof readFile !== "function") {
    throw new Error("Canvas file access requires the Stella desktop app.");
  }
  const result = await readFile(filePath);
  if (result.missing) {
    throw new Error("Canvas file is missing.");
  }
  return decoder.decode(result.bytes);
};

const copyToClipboard = async (value: string): Promise<void> => {
  await navigator.clipboard.writeText(value);
};

const formatDate = (ms: number): string => {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
};

const ShareResultView = ({
  status,
  result,
}: {
  status: PublishStatus;
  result: PublishedCanvasShare | null;
}) => {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (!result) return;
    try {
      await copyToClipboard(result.url);
      setCopied(true);
      showToast("Share link copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      showToast("Couldn't copy the link");
    }
  }, [result]);

  if (status === "publishing") {
    return (
      <div className="canvas-share__state">
        <LoaderCircle size={15} className="canvas-share__spin" aria-hidden />
        <span>Publishing canvas…</span>
      </div>
    );
  }
  if (status === "error" || !result) {
    return (
      <div className="canvas-share__state canvas-share__state--error">
        Couldn't publish this canvas. Please try again.
      </div>
    );
  }
  return (
    <div className="canvas-share__result">
      <div className="canvas-share__result-head">
        <Check size={14} strokeWidth={2} aria-hidden />
        <span>Canvas is live</span>
      </div>
      <div className="canvas-share__url-row">
        <input
          className="canvas-share__url"
          value={result.url}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Public canvas link"
        />
        <button
          type="button"
          className="canvas-share__copy"
          onClick={() => void onCopy()}
          aria-label="Copy link"
        >
          {copied ? (
            <Check size={14} strokeWidth={2} aria-hidden />
          ) : (
            <Copy size={14} strokeWidth={1.6} aria-hidden />
          )}
        </button>
      </div>
      {result.expiresAt ? (
        <div className="canvas-share__meta">
          Expires {formatDate(result.expiresAt)}
        </div>
      ) : null}
    </div>
  );
};

const SharedLinksPanel = () => {
  const share = useCanvasShare();
  const version = share?.version ?? 0;
  const [links, setLinks] = useState<SharedCanvasLink[] | null>(null);
  const [error, setError] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!share) return;
    setError(false);
    try {
      setLinks(await share.listMine());
    } catch {
      setError(true);
    }
  }, [share]);

  // Reload whenever the panel mounts or a publish/revoke bumps `version`.
  useEffect(() => {
    void load();
  }, [load, version]);

  const onCopy = useCallback(async (link: SharedCanvasLink) => {
    try {
      await copyToClipboard(link.url);
      setCopiedSlug(link.slug);
      showToast("Share link copied");
      window.setTimeout(() => setCopiedSlug(null), 1600);
    } catch {
      showToast("Couldn't copy the link");
    }
  }, []);

  const onRevoke = useCallback(
    async (slug: string) => {
      if (!share) return;
      setRevoking(slug);
      try {
        await share.revoke({ slug });
        setLinks((current) =>
          current ? current.filter((link) => link.slug !== slug) : current,
        );
        showToast("Share revoked");
      } catch {
        showToast("Couldn't revoke this share");
      } finally {
        setRevoking(null);
      }
    },
    [share],
  );

  return (
    <div className="canvas-share__links">
      <div className="canvas-share__links-title">Shared links</div>
      {error ? (
        <div className="canvas-share__state canvas-share__state--error">
          Couldn't load your shares.
        </div>
      ) : links === null ? (
        <div className="canvas-share__state">
          <LoaderCircle size={15} className="canvas-share__spin" aria-hidden />
          <span>Loading…</span>
        </div>
      ) : links.length === 0 ? (
        <div className="canvas-share__empty">
          No active shares yet. Publish a canvas to get a public link.
        </div>
      ) : (
        <ul className="canvas-share__list">
          {links.map((link) => (
            <li key={link.slug} className="canvas-share__item">
              <div className="canvas-share__item-main">
                <span className="canvas-share__item-title">
                  {link.title?.trim() || "Untitled canvas"}
                </span>
                <span className="canvas-share__item-url">{link.url}</span>
                <span className="canvas-share__item-meta">
                  Shared {formatDate(link.createdAt)}
                  {link.expiresAt
                    ? ` · expires ${formatDate(link.expiresAt)}`
                    : ""}
                </span>
              </div>
              <div className="canvas-share__item-actions">
                <button
                  type="button"
                  className="canvas-share__icon-btn"
                  aria-label="Copy link"
                  onClick={() => void onCopy(link)}
                >
                  {copiedSlug === link.slug ? (
                    <Check size={13} strokeWidth={2} aria-hidden />
                  ) : (
                    <Copy size={13} strokeWidth={1.6} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  className="canvas-share__icon-btn canvas-share__icon-btn--danger"
                  aria-label="Revoke share"
                  disabled={revoking === link.slug}
                  onClick={() => void onRevoke(link.slug)}
                >
                  {revoking === link.slug ? (
                    <LoaderCircle
                      size={13}
                      className="canvas-share__spin"
                      aria-hidden
                    />
                  ) : (
                    <Trash2 size={13} strokeWidth={1.6} aria-hidden />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const CanvasShareBar = ({ item }: { item: CanvasHtmlItem }) => {
  const share = useCanvasShare();
  const [shareOpen, setShareOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [status, setStatus] = useState<PublishStatus>("idle");
  const [result, setResult] = useState<PublishedCanvasShare | null>(null);

  const onPublish = useCallback(async () => {
    if (!share) return;
    setStatus("publishing");
    setResult(null);
    setShareOpen(true);
    try {
      const html = await readCanvasHtml(item.filePath);
      const published = await share.publish({
        html,
        title: item.title,
      });
      setResult(published);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }, [share, item.filePath, item.title]);

  // No canvas-share context (mini window / no provider) → no share UI.
  if (!share) return null;

  return (
    <div className="canvas-share">
      <Popover open={shareOpen} onOpenChange={setShareOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="canvas-share__btn canvas-share__btn--primary"
            onClick={() => {
              if (status !== "publishing") void onPublish();
            }}
            disabled={status === "publishing"}
          >
            <Globe size={14} strokeWidth={1.6} aria-hidden />
            <span>Share</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="canvas-share__popover"
          align="end"
          side="bottom"
          sideOffset={8}
        >
          <ShareResultView status={status} result={result} />
        </PopoverContent>
      </Popover>

      <Popover open={linksOpen} onOpenChange={setLinksOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="canvas-share__btn"
            aria-label="Shared links"
          >
            <span>Links</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="canvas-share__popover canvas-share__popover--links"
          align="end"
          side="bottom"
          sideOffset={8}
        >
          {linksOpen ? <SharedLinksPanel /> : null}
        </PopoverContent>
      </Popover>
    </div>
  );
};
