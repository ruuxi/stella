/**
 * TEMPORARY — delete this file and the early return in MediaTabContent when
 * done reviewing the media tab layout polish.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Copy, Download, Folder, Plus, Trash2, X } from "lucide-react";
import { updateComposerTextareaExpansion } from "@/shared/hooks/use-animated-composer-shell";
import { MEDIA_ACTIONS, type MediaActionId } from "./media-actions";
import { HeroPrompt } from "./HeroPrompt";
import "../media-tab.css";

/** Flip to false (or delete this module) to restore the real media tab. */
export const MEDIA_TAB_VISUAL_MOCK = true;

type MockRailItem = {
  id: string;
  thumbUrl: string;
  label: string;
  kind: "image" | "video" | "audio";
};

const MOCK_RAIL: MockRailItem[] = [
  {
    id: "mock-1",
    thumbUrl: "https://picsum.photos/seed/stella-media-1/112/112",
    label: "Photo",
    kind: "image",
  },
  {
    id: "mock-2",
    thumbUrl: "https://picsum.photos/seed/stella-media-2/112/112",
    label: "Photo",
    kind: "image",
  },
  {
    id: "mock-3",
    thumbUrl: "https://picsum.photos/seed/stella-media-3/112/112",
    label: "Video",
    kind: "video",
  },
  {
    id: "mock-4",
    thumbUrl: "https://picsum.photos/seed/stella-media-4/112/112",
    label: "Photo",
    kind: "image",
  },
  {
    id: "mock-5",
    thumbUrl: "https://picsum.photos/seed/stella-media-5/112/112",
    label: "Audio",
    kind: "audio",
  },
];

const MOCK_HERO_BY_ID: Record<string, { imageUrl: string; prompt: string }> = {
  "mock-1": {
    imageUrl: "https://picsum.photos/seed/stella-media-hero-1/900/700",
    prompt:
      "A calm desk at golden hour, soft window light, minimal objects, with a ceramic mug, an open notebook filled with handwritten notes, a small succulent in a terracotta pot, and warm shadows stretching across a walnut surface while the city skyline fades into haze outside the window",
  },
  "mock-2": {
    imageUrl: "https://picsum.photos/seed/stella-media-hero-2/900/700",
    prompt: "Mist over pine trees at dawn, cool blue tones",
  },
  "mock-3": {
    imageUrl: "https://picsum.photos/seed/stella-media-hero-3/900/700",
    prompt: "City street at night, gentle rain on pavement",
  },
  "mock-4": {
    imageUrl: "https://picsum.photos/seed/stella-media-hero-4/900/700",
    prompt: "Open notebook beside a ceramic mug, overhead view",
  },
  "mock-5": {
    imageUrl: "https://picsum.photos/seed/stella-media-hero-5/900/700",
    prompt: "Soft gradient sky over quiet hills",
  },
};

const DEFAULT_HERO = {
  capability: "text to image",
  prompt: "A calm desk at golden hour, soft window light, minimal objects",
  imageUrl: "https://picsum.photos/seed/stella-media-hero-1/900/700",
};

export const MediaTabVisualMock = () => {
  const [selectedId, setSelectedId] = useState(MOCK_RAIL[0]?.id ?? "mock-1");
  const [actionId, setActionId] = useState<MediaActionId>("image_edit");
  const [attachedId, setAttachedId] = useState<string | null>("mock-1");
  const [prompt, setPrompt] = useState("Make the sky a deeper blue at sunset");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (prompt === "") {
      setComposerExpanded(false);
      return;
    }
    requestAnimationFrame(() => {
      updateComposerTextareaExpansion(
        promptInputRef.current,
        setComposerExpanded,
      );
    });
  }, [prompt]);

  const selected =
    MOCK_RAIL.find((item) => item.id === selectedId) ?? MOCK_RAIL[0] ?? null;
  const hero = selected
    ? {
        capability: DEFAULT_HERO.capability,
        prompt:
          MOCK_HERO_BY_ID[selected.id]?.prompt ??
          `${selected.label} preview`,
        imageUrl:
          MOCK_HERO_BY_ID[selected.id]?.imageUrl ?? DEFAULT_HERO.imageUrl,
      }
    : DEFAULT_HERO;
  const attached =
    MOCK_RAIL.find((item) => item.id === attachedId) ?? null;
  const activeAction =
    MEDIA_ACTIONS.find((action) => action.id === actionId) ?? MEDIA_ACTIONS[0];
  const visibleActions = MEDIA_ACTIONS.filter(
    (action) =>
      !action.sourceKind ||
      (attached != null && action.sourceKind === attached.kind),
  );
  const showAttachedChip =
    attached &&
    activeAction.sourceKind &&
    attached.kind === activeAction.sourceKind;

  return (
    <div className="media-tab">
      <div className="media-tab__surface">
      <div className="media-tab__main">
      <div className="media-tab__hero">
            <div className="media-tab__hero-bar">
              <div className="media-tab__hero-bar-top">
                <span className="media-tab__hero-cap">{hero.capability}</span>
                <div
                  className="media-tab__hero-actions"
                  role="group"
                  aria-label="Item actions"
                >
                <button
                  type="button"
                  className="media-tab__action-btn"
                  aria-label="Save"
                  title="Save"
                >
                  <Download size={14} strokeWidth={1.85} />
                </button>
                <button
                  type="button"
                  className="media-tab__action-btn"
                  aria-label="Copy"
                  title="Copy"
                >
                  <Copy size={14} strokeWidth={1.85} />
                </button>
                <button
                  type="button"
                  className={
                    confirmDelete
                      ? "media-tab__action-btn media-tab__action-btn--danger"
                      : "media-tab__action-btn"
                  }
                  aria-label={
                    confirmDelete ? "Click again to delete" : "Delete"
                  }
                  title={confirmDelete ? "Click again to delete" : "Delete"}
                  onClick={() => setConfirmDelete((prev) => !prev)}
                >
                  <Trash2 size={14} strokeWidth={1.85} />
                </button>
              </div>
              </div>
              <HeroPrompt text={hero.prompt} />
            </div>
            <div className="media-tab__hero-preview">
              <div className="display-media display-media--image">
                <button type="button" className="display-media__primary-btn">
                  <img
                    src={hero.imageUrl}
                    alt={hero.prompt}
                    className="display-media__primary-img"
                  />
                </button>
              </div>
            </div>
      </div>
      </div>

      <div className="media-tab__footer">
      <div className="media-tab__rail" aria-label="Generated media">
        <button
          type="button"
          className="media-tab__rail-import"
          aria-label="Add a file from your computer"
          title="Add a file from your computer"
        >
          <Folder size={18} strokeWidth={1.85} />
        </button>
        {[...MOCK_RAIL].reverse().map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            className={[
              "media-tab__tile",
              item.id === selectedId ? "media-tab__tile--active" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={item.label}
            aria-pressed={item.id === selectedId}
            onClick={() => setSelectedId(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedId(item.id);
              }
            }}
          >
            <img
              className="media-tab__tile-img"
              src={item.thumbUrl}
              alt=""
            />
            {item.kind !== "image" ? (
              <span className="media-tab__tile-badge">
                {item.kind === "video" ? "MP4" : "WAV"}
              </span>
            ) : null}
            <button
              type="button"
              className="media-tab__tile-attach"
              aria-label="Use this media"
              title="Use this media"
              onClick={(event) => {
                event.stopPropagation();
                setAttachedId(item.id);
                setActionId("image_edit");
              }}
            >
              <Plus size={12} strokeWidth={2.4} />
            </button>
          </div>
        ))}
      </div>

      <form
        className={`media-tab__composer${composerExpanded ? " expanded" : ""}`}
        onSubmit={(event) => event.preventDefault()}
      >
        <div
          className="media-tab__modes"
          role="tablist"
          aria-label="Media modes"
        >
          {visibleActions.map((action) => {
            const attachedHere =
              attached && attached.kind === action.sourceKind;
            const disabled = action.sourceKind === "image" && !attachedHere;
            return (
              <button
                key={action.id}
                type="button"
                role="tab"
                aria-selected={action.id === activeAction.id}
                className={
                  action.id === activeAction.id
                    ? "media-tab__mode media-tab__mode--active"
                    : "media-tab__mode"
                }
                disabled={disabled}
                onClick={() => setActionId(action.id)}
              >
                {action.label}
              </button>
            );
          })}
        </div>
        <div className="media-tab__composer-row">
          {showAttachedChip && attached ? (
            <span className="media-tab__attached" role="group">
              <span className="media-tab__attached-clip">
                <img
                  className="media-tab__attached-thumb"
                  src={attached.thumbUrl}
                  alt=""
                />
              </span>
              <button
                type="button"
                className="media-tab__attached-x"
                aria-label="Remove attached media"
                title="Remove"
                onClick={() => setAttachedId(null)}
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            </span>
          ) : null}
          <textarea
            ref={promptInputRef}
            className="media-tab__prompt-input"
            value={prompt}
            rows={1}
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              requestAnimationFrame(() => {
                updateComposerTextareaExpansion(
                  promptInputRef.current,
                  setComposerExpanded,
                );
              });
            }}
            placeholder={activeAction.placeholder}
            aria-label={activeAction.placeholder}
          />
          <button
            type="submit"
            className="media-tab__prompt-submit"
            aria-label="Make"
          >
            <ArrowUp size={14} strokeWidth={2.4} />
          </button>
        </div>
      </form>
      </div>
      </div>
    </div>
  );
};
