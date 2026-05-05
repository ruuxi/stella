/**
 * Store side panel.
 *
 * Three stacked surfaces:
 * 1. Recent changes — the rolling-window feature snapshot. Each row has
 *    explicit Add (multi-select chip) and Publish (auto-fires a draft
 *    request) actions on the right.
 * 2. Chat thread — local messages with the Store agent rendered through
 *    the same `UserMessageRow` / `AssistantMessageRow` components as the
 *    full chat / chat sidebar, so bubble alignment, markdown, and
 *    spacing match across surfaces. Pending state shows a calm two-line
 *    "Drafting your blueprint." indicator.
 * 3. Composer — reuses the chat-sidebar shell verbatim
 *    (`.chat-sidebar-composer` / `.chat-sidebar-shell` / etc.) so the
 *    pill, focus glow, and animated submit button match the chat
 *    sidebar.
 *
 * Blueprint drafts render as an `EndResourceCard`-shaped artifact pill
 * inside the assistant row, with a right-aligned bordered state badge
 * ("Review required" / "Published" / "Denied"). Clicking opens a glass
 * Radix `Dialog` with the markdown on a solid surface; approving opens
 * a second glass dialog for the publish form.
 *
 * When a new blueprint draft lands while the panel is mounted, fires an
 * OS notification so the user gets pulled back even if the side panel
 * isn't on top.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  refreshFeatureSnapshot,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import { FileText, RefreshCw, X } from "lucide-react";
import { showToast } from "@/ui/toast";
import { Markdown } from "@/app/chat/Markdown";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import {
  AssistantMessageRow,
  UserMessageRow,
  type AssistantRowViewModel,
  type UserRowViewModel,
} from "@/app/chat/MessageRow";
import "@/app/chat/full-shell.chat.css";
import "@/app/chat/compact-conversation.css";
import "@/app/chat/end-resource-card.css";
import "@/app/chat/composer-primitives.css";
import "@/shell/chat-sidebar.css";

const EDIT_BLUEPRINT_PROMPT = "What do you want to change?";
const EMPTY_STORE_THREAD_MESSAGES: StoreThreadMessage[] = [];

type StoreThreadMessage = {
  _id: string;
  role: "user" | "assistant" | "system_event";
  text: string;
  isBlueprint?: boolean;
  denied?: boolean;
  published?: boolean;
  publishedReleaseNumber?: number;
  pending?: boolean;
  attachedFeatureNames?: string[];
  editingBlueprint?: boolean;
};

type StoreThreadResult = {
  threadId: string | null;
  messages: StoreThreadMessage[];
};

type StoreCategory =
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other";

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Pull a friendly blueprint name from the leading `# Heading` of the
 * markdown, falling back to "Blueprint" if there isn't one. Keeps the
 * pill's secondary line readable without inventing a separate field.
 */
function deriveBlueprintName(text: string): string {
  const match = text.match(/^\s*#\s+(.+?)\s*$/m);
  if (match && match[1]) return match[1].trim();
  return "Blueprint";
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function requestNotificationPermission() {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    // ignore
  }
}

function fireBlueprintNotification(name: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    new Notification("Blueprint draft ready", {
      body: `${name} is ready to review and publish.`,
    });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Publish dialog (glass + Radix)
// ---------------------------------------------------------------------------

type PublishDialogProps = {
  open: boolean;
  blueprint: StoreThreadMessage | null;
  onClose: () => void;
  onPublished: (args: {
    messageId: string;
    releaseNumber: number;
  }) => Promise<void> | void;
};

function PublishDialog({
  open,
  blueprint,
  onClose,
  onPublished,
}: PublishDialogProps) {
  const myPackages = useQuery(
    api.data.store_packages.listMyPackages,
    open ? {} : "skip",
  );
  const [packageId, setPackageId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<StoreCategory | "">("");
  const [asUpdate, setAsUpdate] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPackageId("");
      setDisplayName("");
      setDescription("");
      setCategory("");
      setAsUpdate(false);
      setSubmitting(false);
    }
  }, [open]);

  const handleNameChange = (value: string) => {
    setDisplayName(value);
    if (!packageId) {
      const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      setPackageId(slug);
    }
  };

  const ownedPackages = (myPackages ?? []) as Array<{
    packageId: string;
    displayName: string;
    description: string;
    category?: StoreCategory;
  }>;

  const handleSubmit = async () => {
    const selectedPackage = ownedPackages.find(
      (pkg) => pkg.packageId === packageId.trim(),
    );
    const publishDisplayName = asUpdate
      ? selectedPackage?.displayName
      : displayName.trim();
    const publishDescription = asUpdate
      ? selectedPackage?.description
      : description.trim();
    const publishCategory = asUpdate
      ? selectedPackage?.category
      : category || undefined;
    if (
      !packageId.trim() ||
      !publishDisplayName?.trim() ||
      !publishDescription?.trim()
    ) {
      showToast({
        title: "Missing fields",
        description: asUpdate
          ? "Choose the add-on you want to update."
          : "Package ID, name, and description are all required.",
        variant: "error",
      });
      return;
    }
    if (!blueprint) {
      showToast({
        title: "No blueprint",
        description: "Ask the Store agent to draft a blueprint first.",
        variant: "error",
      });
      return;
    }
    const normalizedPackageId = packageId.trim();
    const manifest = {
      ...(publishCategory ? { category: publishCategory } : {}),
      summary: publishDescription.trim().slice(0, 500),
    };
    const storeApi = window.electronAPI?.store;
    if (!storeApi?.publishBlueprint) {
      showToast({
        title: "Publish failed",
        description: "Publish backend is not available.",
        variant: "error",
      });
      return;
    }
    const publishArgs = {
      messageId: blueprint._id,
      packageId: normalizedPackageId,
      asUpdate,
      manifest,
      ...(asUpdate
        ? {}
        : {
            displayName: publishDisplayName.trim(),
            description: publishDescription.trim(),
            ...(publishCategory ? { category: publishCategory } : {}),
          }),
    };
    const publishedMessageId = blueprint._id;
    const toastName = publishDisplayName.trim();
    setSubmitting(true);
    onClose();
    showToast({
      title: "Publishing",
      description: "Stella will let you know when it's finished.",
    });
    void (async () => {
      try {
        // The worker resolves the source message → attached features →
        // commit hashes → redacted reference diffs and ships the spec
        // and diffs to Convex in one round-trip. The renderer no longer
        // talks to Convex directly here.
        const release = await storeApi.publishBlueprint(publishArgs);
        await onPublished({
          messageId: publishedMessageId,
          releaseNumber: release.releaseNumber,
        });
        showToast({
          title: "Published",
          description: `${toastName} is now in the store.`,
        });
      } catch (error) {
        showToast({
          title: "Publish failed",
          description: (error as Error)?.message,
          variant: "error",
        });
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent fit className="store-publish-dialog">
        <DialogHeader>
          <DialogTitle>
            {asUpdate ? "Publish update" : "Publish to Store"}
          </DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          {ownedPackages.length > 0 ? (
            <label className="store-publish-dialog-row">
              <input
                type="checkbox"
                checked={asUpdate}
                onChange={(event) => setAsUpdate(event.target.checked)}
              />
              <span>Update an existing add-on</span>
            </label>
          ) : null}

          {asUpdate ? (
            <label className="store-publish-dialog-field">
              <span className="store-publish-dialog-field-label">
                Existing add-on
              </span>
              <select
                value={packageId}
                onChange={(event) => setPackageId(event.target.value)}
              >
                <option value="">Select…</option>
                {ownedPackages.map((pkg) => (
                  <option key={pkg.packageId} value={pkg.packageId}>
                    {pkg.displayName} ({pkg.packageId})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => handleNameChange(event.target.value)}
                  placeholder="Example mod"
                  maxLength={120}
                />
              </label>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">
                  Package ID
                </span>
                <input
                  type="text"
                  value={packageId}
                  onChange={(event) => setPackageId(event.target.value)}
                  placeholder="example-mod"
                  maxLength={64}
                />
              </label>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">
                  Description
                </span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="A short description for the store listing."
                  rows={3}
                  maxLength={4_000}
                />
              </label>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">
                  Category
                </span>
                <select
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as typeof category)
                  }
                >
                  <option value="">Pick a category…</option>
                  <option value="apps-games">Apps & games</option>
                  <option value="productivity">Productivity</option>
                  <option value="customization">Customization</option>
                  <option value="skills-agents">Skills & agents</option>
                  <option value="integrations">Integrations</option>
                  <option value="other">Other</option>
                </select>
              </label>
            </>
          )}

          <div className="store-publish-dialog-actions">
            <button
              type="button"
              className="pill-btn"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? "Publishing…" : "Publish"}
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Blueprint review dialog (glass + Radix)
// ---------------------------------------------------------------------------

type BlueprintDialogProps = {
  open: boolean;
  message: StoreThreadMessage | null;
  /** True only for the most recent non-denied blueprint draft. */
  canApprove: boolean;
  denying: boolean;
  onClose: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onEdit: () => void;
};

function BlueprintDialog({
  open,
  message,
  canApprove,
  denying,
  onClose,
  onApprove,
  onDeny,
  onEdit,
}: BlueprintDialogProps) {
  const denied = Boolean(message?.denied);
  const published = Boolean(message?.published);
  const titleSuffix = denied
    ? " (denied)"
    : published
      ? ` (published${message?.publishedReleaseNumber ? ` v${message.publishedReleaseNumber}` : ""})`
      : "";
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent fit className="store-blueprint-dialog">
        <DialogHeader>
          <DialogTitle>Blueprint draft{titleSuffix}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="store-blueprint-dialog-viewer">
            {message ? (
              <Markdown text={message.text} cacheKey={message._id} />
            ) : null}
          </div>
          <div className="store-blueprint-dialog-actions">
            <button
              type="button"
              className="pill-btn"
              onClick={onEdit}
              disabled={!message || denying}
            >
              Edit
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--danger"
              onClick={onDeny}
              disabled={!canApprove || denying}
            >
              {denying ? "Denying…" : "Deny"}
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              onClick={onApprove}
              disabled={!canApprove || denying}
              title={
                canApprove
                  ? "Open the publish form"
                  : denied
                    ? "This draft was denied. Pick the latest draft to publish."
                    : "Only the latest draft can be published."
              }
            >
              Approve & publish
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Blueprint pill (artifact-card style)
// ---------------------------------------------------------------------------

function BlueprintPill({
  name,
  denied,
  published,
  onOpen,
}: {
  name: string;
  denied: boolean;
  published: boolean;
  onOpen: () => void;
}) {
  const tier = denied ? "denied" : published ? "published" : "review";
  const badgeLabel = denied
    ? "Denied"
    : published
      ? "Published"
      : "Review required";
  return (
    <button
      type="button"
      className="end-resource-card store-side-panel-blueprint-card"
      data-denied={denied || undefined}
      onClick={onOpen}
    >
      <span className="end-resource-card__icon">
        <FileText size={20} />
      </span>
      <span className="end-resource-card__text">
        <span className="end-resource-card__label">Blueprint draft</span>
        <span className="end-resource-card__action">{name}</span>
      </span>
      <span className="store-side-panel-blueprint-badge" data-tier={tier}>
        {badgeLabel}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Recent-changes row
// ---------------------------------------------------------------------------

function RecentRow({
  name,
  meta,
  selected,
  onAdd,
  onPublish,
}: {
  name: string;
  meta: string | null;
  selected: boolean;
  onAdd: () => void;
  onPublish: () => void;
}) {
  return (
    <div className="store-side-panel-row" data-selected={selected || undefined}>
      <div className="store-side-panel-row-text">
        <span className="store-side-panel-row-title">{name}</span>
        {meta ? (
          <span className="store-side-panel-row-meta">{meta}</span>
        ) : null}
      </div>
      <div className="store-side-panel-row-actions">
        <button
          type="button"
          className="store-side-panel-pill"
          data-active={selected || undefined}
          onClick={onAdd}
          title={selected ? "Remove from composer" : "Add to composer"}
        >
          {selected ? "Added" : "Add"}
        </button>
        <button
          type="button"
          className="store-side-panel-pill"
          data-variant="primary"
          onClick={onPublish}
          title="Draft a blueprint to publish this change"
        >
          Publish
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageRow adapters
// ---------------------------------------------------------------------------

function toUserRow(msg: StoreThreadMessage): UserRowViewModel {
  return {
    kind: "user",
    id: msg._id,
    text: msg.text,
    attachments: [],
  };
}

function toAssistantRow(msg: StoreThreadMessage): AssistantRowViewModel {
  return {
    kind: "assistant",
    id: msg._id,
    text: msg.text,
    cacheKey: msg._id,
    isAnimating: msg.pending === true,
  };
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

export function StoreSidePanel() {
  const state = useStoreSidePanelState();
  const [thread, setThread] = useState<StoreThreadResult>({
    threadId: null,
    messages: [],
  });
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [reviewingMessage, setReviewingMessage] =
    useState<StoreThreadMessage | null>(null);
  /**
   * "Edit" mode: the user clicked Edit on a blueprint badge. The
   * composer shows a chip referencing the draft, and the next send
   * passes editingBlueprint=true so the agent's opening message gets
   * the refinement framing.
   */
  const [editingBlueprintId, setEditingBlueprintId] = useState<string | null>(
    null,
  );
  const [denying, setDenying] = useState(false);

  /**
   * Tracks the set of blueprint message ids we've already seen so we
   * can fire an OS notification when a *new* blueprint lands.
   */
  const seenBlueprintsRef = useRef<Set<string>>(new Set());
  const hasSeededBlueprintsRef = useRef(false);

  useEffect(() => {
    void refreshFeatureSnapshot();
    void window.electronAPI?.store
      ?.getThread?.()
      .then((nextThread) => {
        if (nextThread) setThread(nextThread);
      })
      .catch(() => undefined);
    void requestNotificationPermission();
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  const items = state.snapshot?.items ?? [];
  const messages = thread?.messages ?? EMPTY_STORE_THREAD_MESSAGES;
  /** Latest non-denied, unpublished blueprint draft (mirrors the server-side query). */
  const latestPublishableBlueprint = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (
        msg &&
        msg.role === "assistant" &&
        msg.isBlueprint &&
        !msg.denied &&
        !msg.published
      ) {
        return msg;
      }
    }
    return null;
  }, [messages]);
  const editingBlueprintMessage = useMemo(() => {
    if (!editingBlueprintId) return null;
    return messages.find((msg) => msg._id === editingBlueprintId) ?? null;
  }, [editingBlueprintId, messages]);
  const isInFlight = useMemo(
    () =>
      messages.some((msg) => msg.role === "assistant" && msg.pending === true),
    [messages],
  );

  // Surface an OS notification when a brand-new blueprint draft arrives
  // (i.e. one we've never observed in this session). Seed the "seen"
  // set on first load so existing drafts don't re-fire on mount.
  useEffect(() => {
    const blueprints = messages.filter(
      (msg) =>
        msg.role === "assistant" && msg.isBlueprint && !msg.denied,
    );
    if (!hasSeededBlueprintsRef.current) {
      hasSeededBlueprintsRef.current = true;
      seenBlueprintsRef.current = new Set(blueprints.map((msg) => msg._id));
      return;
    }
    for (const msg of blueprints) {
      if (seenBlueprintsRef.current.has(msg._id)) continue;
      seenBlueprintsRef.current.add(msg._id);
      fireBlueprintNotification(deriveBlueprintName(msg.text));
    }
  }, [messages]);

  useEffect(() => {
    if (!isInFlight) return;
    const timer = window.setInterval(() => {
      void window.electronAPI?.store
        ?.getThread?.()
        .then((nextThread) => {
          if (nextThread) setThread(nextThread);
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isInFlight]);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const nextThread = await window.electronAPI?.store.cancelThreadTurn();
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
    } catch (error) {
      showToast({
        title: "Couldn't stop the agent",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setStopping(false);
    }
  }, [stopping]);

  /**
   * Common send pipeline. Used both by the composer's submit button
   * and the per-row Publish button (which auto-fires a draft prompt
   * with the feature attached).
   */
  const sendThreadTurn = useCallback(
    async (args: {
      text: string;
      attachedFeatureNames?: string[];
      editingBlueprint?: boolean;
    }) => {
      const storeApi = window.electronAPI?.store;
      if (!storeApi?.sendThreadMessage) {
        showToast({
          title: "Send failed",
          description:
            "The local Store agent is not ready yet. Try again in a moment.",
          variant: "error",
        });
        return;
      }
      setSending(true);
      try {
        const nextThread = await storeApi.sendThreadMessage({
          text: args.text,
          ...(args.attachedFeatureNames && args.attachedFeatureNames.length > 0
            ? { attachedFeatureNames: args.attachedFeatureNames }
            : {}),
          ...(args.editingBlueprint ? { editingBlueprint: true } : {}),
        });
        setThread(nextThread);
      } catch (error) {
        showToast({
          title: "Send failed",
          description: (error as Error)?.message,
          variant: "error",
        });
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const text = composer.trim();
    if (!text || sending) return;
    const attachedFeatureNames = Array.from(state.selectedFeatureNames);
    const editingBlueprint = Boolean(editingBlueprintMessage);
    await sendThreadTurn({ text, attachedFeatureNames, editingBlueprint });
    setComposer("");
    setEditingBlueprintId(null);
    storeSidePanelStore.clearSelections();
  }, [
    composer,
    editingBlueprintMessage,
    sending,
    sendThreadTurn,
    state.selectedFeatureNames,
  ]);

  const handlePublishRow = useCallback(
    async (name: string) => {
      await sendThreadTurn({
        text: `Draft a blueprint to publish: ${name}`,
        attachedFeatureNames: [name],
      });
    },
    [sendThreadTurn],
  );

  const handleApproveBlueprint = useCallback(() => {
    setReviewingMessage(null);
    setPublishOpen(true);
  }, []);

  const handleDenyBlueprint = useCallback(async () => {
    if (denying) return;
    setDenying(true);
    try {
      const nextThread = await window.electronAPI?.store.denyLatestBlueprint();
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
      setReviewingMessage(null);
    } catch (error) {
      showToast({
        title: "Couldn't deny the draft",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setDenying(false);
    }
  }, [denying]);

  const handleBlueprintPublished = useCallback(
    async (args: { messageId: string; releaseNumber: number }) => {
      const nextThread =
        await window.electronAPI?.store.markBlueprintPublished(args);
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
      setReviewingMessage(null);
      setPublishOpen(false);
    },
    [],
  );

  const handleEditBlueprint = useCallback((message: StoreThreadMessage) => {
    setEditingBlueprintId(message._id);
    setReviewingMessage(null);
    const syntheticId = `synthetic-edit:${message._id}`;
    setThread((prev) => {
      if (prev.messages.some((entry) => entry._id === syntheticId)) return prev;
      return {
        ...prev,
        messages: [
          ...prev.messages,
          {
            _id: syntheticId,
            role: "assistant",
            text: EDIT_BLUEPRINT_PROMPT,
          },
        ],
      };
    });
  }, []);

  const renderMessage = (message: StoreThreadMessage) => {
    if (message.role === "user") {
      const features = message.attachedFeatureNames ?? [];
      return (
        <div key={message._id}>
          {features.length > 0 ? (
            <div className="store-side-panel-user-chips">
              {features.map((name) => (
                <span key={name} className="store-side-panel-user-chip">
                  {name}
                </span>
              ))}
            </div>
          ) : null}
          <UserMessageRow row={toUserRow(message)} />
        </div>
      );
    }

    if (message.isBlueprint) {
      const name = deriveBlueprintName(message.text);
      const row: AssistantRowViewModel = {
        ...toAssistantRow(message),
        text: "",
        customSlot: (
          <BlueprintPill
            name={name}
            denied={Boolean(message.denied)}
            published={Boolean(message.published)}
            onOpen={() => setReviewingMessage(message)}
          />
        ),
        customSlotKey: `blueprint:${message._id}:${message.denied ? "denied" : message.published ? "published" : "review"}`,
      };
      return <AssistantMessageRow key={message._id} row={row} />;
    }

    if (message.pending && !message.text.trim()) {
      return (
        <div key={message._id} className="store-side-panel-drafting">
          Drafting your blueprint.
          <span className="store-side-panel-drafting-sub">
            This may take a couple of minutes.
          </span>
        </div>
      );
    }

    return <AssistantMessageRow key={message._id} row={toAssistantRow(message)} />;
  };

  return (
    <div
      className="display-sidebar__rich display-sidebar__rich--store store-side-panel"
      data-store-display-tab="store"
    >
      <div className="store-side-panel-header">
        <span>Recent changes</span>
        <button
          type="button"
          className="store-side-panel-refresh"
          onClick={() => void refreshFeatureSnapshot()}
          disabled={state.snapshotLoading}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {state.snapshotLoading && items.length === 0 ? (
        <div className="store-side-panel-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="store-side-panel-empty">
          No recent changes yet. After Stella makes a change for you, it'll show
          up here.
        </div>
      ) : (
        <div className="store-side-panel-list">
          {items.map((item, index) => {
            const selected = state.selectedFeatureNames.has(item.name);
            return (
              <RecentRow
                key={`${index}:${item.name}`}
                name={item.name}
                meta={
                  state.snapshot?.generatedAt
                    ? `Updated ${formatTimeAgo(state.snapshot.generatedAt)}`
                    : null
                }
                selected={selected}
                onAdd={() => storeSidePanelStore.toggleFeature(item.name)}
                onPublish={() => void handlePublishRow(item.name)}
              />
            );
          })}
        </div>
      )}

      <div className="store-side-panel-thread">
        {messages.length === 0 ? (
          <div className="store-side-panel-thread-empty">
            Pick changes above or just type — the Store agent will help draft a
            blueprint to publish.
          </div>
        ) : (
          <div className="chat-conversation-surface chat-conversation-surface--sidebar">
            {messages.map(renderMessage)}
          </div>
        )}
      </div>

      {/*
       * Composer reuses the chat-sidebar shell verbatim so it reads as
       * the same component as the chat sidebar / full chat composer.
       */}
      <div className="chat-sidebar-composer">
        <div className="chat-sidebar-shell">
          <div className="chat-sidebar-shell-content">
            {state.selectedFeatureNames.size > 0 || editingBlueprintMessage ? (
              <div className="composer-attached-strip composer-attached-strip--mini">
                {editingBlueprintMessage ? (
                  <button
                    type="button"
                    className="store-side-panel-edit-chip"
                    onClick={() => setEditingBlueprintId(null)}
                    title="Click to drop the edit reference"
                  >
                    <FileText size={12} />
                    <span>Editing blueprint</span>
                    <X size={12} />
                  </button>
                ) : null}
                {Array.from(state.selectedFeatureNames).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="store-side-panel-edit-chip"
                    onClick={() => storeSidePanelStore.toggleFeature(name)}
                    title="Click to remove"
                  >
                    <span>{name}</span>
                    <X size={12} />
                  </button>
                ))}
              </div>
            ) : null}
            <form
              className="chat-sidebar-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSend();
              }}
            >
              <ComposerTextarea
                className="chat-sidebar-input"
                tone="default"
                value={composer}
                rows={1}
                placeholder={
                  editingBlueprintMessage
                    ? "Describe the change you want to the draft…"
                    : "What do you want to publish?"
                }
                disabled={sending || isInFlight}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <div className="composer-toolbar">
                <div className="composer-toolbar-left" />
                <div className="composer-toolbar-right">
                  {isInFlight ? (
                    <ComposerStopButton
                      className="composer-stop"
                      onClick={() => void handleStop()}
                      disabled={stopping}
                      title="Stop"
                      aria-label="Stop"
                    />
                  ) : (
                    <ComposerSubmitButton
                      className="composer-submit"
                      disabled={sending || !composer.trim()}
                      animated
                    />
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>

      <BlueprintDialog
        open={Boolean(reviewingMessage)}
        message={reviewingMessage}
        canApprove={
          !!latestPublishableBlueprint &&
          !!reviewingMessage &&
          latestPublishableBlueprint._id === reviewingMessage._id
        }
        denying={denying}
        onClose={() => setReviewingMessage(null)}
        onApprove={handleApproveBlueprint}
        onDeny={() => void handleDenyBlueprint()}
        onEdit={() => {
          if (reviewingMessage) handleEditBlueprint(reviewingMessage);
        }}
      />

      <PublishDialog
        open={publishOpen}
        blueprint={latestPublishableBlueprint}
        onClose={() => setPublishOpen(false)}
        onPublished={handleBlueprintPublished}
      />
    </div>
  );
}
