import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import {
  EMOJI_SHEETS,
  EMOJI_SHEET_CELL_COUNT,
} from "@/app/chat/emoji-sprites/cells";
import {
  useEmojiPackMutations,
  type EmojiPackRecord,
} from "./emoji-pack-data";
import {
  EMOJI_SHEET_INDICES,
  type EmojiSheetIndex,
} from "./emoji-pack-generation";
import { EmojiCellPreview } from "./EmojiCellPreview";

type EmojiPackDetailsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pack: EmojiPackRecord;
  active: boolean;
  hasConnectedAccount: boolean;
  onUse: (pack: EmojiPackRecord) => Promise<void> | void;
  onStop: () => void;
};

/**
 * Pack details + "Get" dialog for the Emoji Store.
 *
 * Browsing the store grid only fetches `coverUrl` (a single emoji). The
 * full `sheet1Url` / `sheet2Url` are heavy WebPs and only get loaded by
 * the renderer when this dialog mounts — that's the explicit "download"
 * step the user sees. Confirming with "Use pack" then activates it for
 * chat. Sign-in is enforced before activation.
 */
export function EmojiPackDetailsDialog({
  open,
  onOpenChange,
  pack,
  active,
  hasConnectedAccount,
  onUse,
  onStop,
}: EmojiPackDetailsDialogProps) {
  const { setVisibility } = useEmojiPackMutations();
  const [previewSheet, setPreviewSheet] = useState<EmojiSheetIndex>(0);
  const [submitting, setSubmitting] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const sheetUrls = useMemo(
    () => [pack.sheet1Url, pack.sheet2Url] as const,
    [pack.sheet1Url, pack.sheet2Url],
  );
  const cellsForActiveSheet = EMOJI_SHEETS[previewSheet] ?? [];
  const author =
    pack.authorDisplayName?.trim() ||
    (pack.authorHandle ? `@${pack.authorHandle}` : "Unknown");

  const handlePrimary = useCallback(async () => {
    if (active) {
      onStop();
      return;
    }
    if (!hasConnectedAccount) {
      showToast({ title: "Sign in to use emoji packs", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      await onUse(pack);
      onOpenChange(false);
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't use pack",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [active, hasConnectedAccount, onOpenChange, onStop, onUse, pack]);

  const handlePromote = useCallback(async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await setVisibility({ packId: pack.packId, visibility: "unlisted" });
      showToast({ title: "Now unlisted (link only)", variant: "success" });
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't update visibility",
        variant: "error",
      });
    } finally {
      setPromoting(false);
    }
  }, [pack.packId, promoting, setVisibility]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="emoji-details-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogTitle>{pack.displayName}</DialogTitle>
        <DialogDescription>
          {pack.description?.trim() || `Pack by ${author}`}
        </DialogDescription>
        <DialogBody className="emoji-details-body">
          <div className="emoji-details-preview">
            <div className="emoji-details-preview-tabs">
              <button
                type="button"
                className="emoji-create-arrow"
                aria-label="Previous sheet"
                disabled={previewSheet === 0}
                onClick={() =>
                  setPreviewSheet((current) =>
                    Math.max(0, current - 1) as EmojiSheetIndex,
                  )
                }
              >
                <ChevronLeft size={16} />
              </button>
              <span className="emoji-create-preview-label">
                Sheet {previewSheet + 1} of {EMOJI_SHEET_INDICES.length}
              </span>
              <button
                type="button"
                className="emoji-create-arrow"
                aria-label="Next sheet"
                disabled={previewSheet === EMOJI_SHEET_INDICES.length - 1}
                onClick={() =>
                  setPreviewSheet((current) =>
                    Math.min(
                      EMOJI_SHEET_INDICES.length - 1,
                      current + 1,
                    ) as EmojiSheetIndex,
                  )
                }
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="emoji-create-grid" data-state="ready">
              {Array.from({ length: EMOJI_SHEET_CELL_COUNT }).map((_, idx) => {
                const glyph = cellsForActiveSheet[idx] ?? "";
                return (
                  <div
                    key={idx}
                    className="emoji-create-cell"
                    title={glyph}
                    aria-label={glyph}
                  >
                    <EmojiCellPreview
                      sheetUrl={sheetUrls[previewSheet]!}
                      cell={idx}
                      size={36}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="emoji-details-side">
            <div className="emoji-details-meta">
              <div className="emoji-details-meta-row">
                <span className="emoji-details-meta-label">Cover</span>
                <span className="emoji-details-meta-value">
                  {pack.coverEmoji}
                </span>
              </div>
              <div className="emoji-details-meta-row">
                <span className="emoji-details-meta-label">Author</span>
                <span className="emoji-details-meta-value">{author}</span>
              </div>
              <div className="emoji-details-meta-row">
                <span className="emoji-details-meta-label">Visibility</span>
                <span className="emoji-details-meta-value">
                  {pack.visibility[0]!.toUpperCase() + pack.visibility.slice(1)}
                </span>
              </div>
            </div>

            {pack.visibility === "private" ? (
              <div className="emoji-details-private-banner">
                <span>This pack is private to you.</span>
                <Button
                  variant="secondary"
                  type="button"
                  size="small"
                  className="pill-btn"
                  disabled={promoting}
                  onClick={() => void handlePromote()}
                >
                  {promoting ? "Updating…" : "Make unlisted"}
                </Button>
              </div>
            ) : null}

            <div className="emoji-details-actions">
              <Button
                type="button"
                variant={active ? "secondary" : "primary"}
                size="large"
                className={
                  active
                    ? "pill-btn pill-btn--lg"
                    : "pill-btn pill-btn--primary pill-btn--lg"
                }
                onClick={() => void handlePrimary()}
                disabled={submitting}
              >
                <Sparkles size={14} />
                {active
                  ? "Stop using"
                  : submitting
                  ? "Getting…"
                  : "Get & use pack"}
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
