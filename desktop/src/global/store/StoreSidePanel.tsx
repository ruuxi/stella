/**
 * Store side panel.
 *
 * Three stacked surfaces:
 * 1. Recent changes — the rolling-window feature snapshot (regenerated
 *    by the cheap-LLM namer after every successful self-mod commit).
 *    The user multi-selects names to attach as context for their next
 *    message to the Store agent.
 * 2. Chat thread — Convex-backed messages with the Store agent. The
 *    agent runs server-side; tool calls go through the global
 *    `StoreAgentToolDispatcher` mounted in `App.tsx` so closing this
 *    panel mid-turn doesn't strand the agent.
 * 3. Composer + Publish — the user types, sends, and (when the agent
 *    has produced a blueprint draft) clicks Publish to ship.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  refreshFeatureSnapshot,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Send from "lucide-react/dist/esm/icons/send";
import StopCircle from "lucide-react/dist/esm/icons/stop-circle";
import FileText from "lucide-react/dist/esm/icons/file-text";
import X from "lucide-react/dist/esm/icons/x";
import { showToast } from "@/ui/toast";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { Markdown } from "@/app/chat/Markdown";

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

// ---------------------------------------------------------------------------
// Publish dialog
// ---------------------------------------------------------------------------

type PublishDialogProps = {
  open: boolean;
  onClose: () => void;
};

function PublishDialog({ open, onClose }: PublishDialogProps) {
  const publish = useAction(api.data.store_thread.publishLatestBlueprint);
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
    setSubmitting(true);
    try {
      await publish({
        packageId: packageId.trim(),
        displayName: publishDisplayName.trim(),
        description: publishDescription.trim(),
        ...(publishCategory ? { category: publishCategory } : {}),
        ...(asUpdate ? { asUpdate: true } : {}),
      });
      showToast({
        title: "Published",
        description: `${publishDisplayName.trim()} is now in the store.`,
      });
      onClose();
    } catch (error) {
      showToast({
        title: "Publish failed",
        description: (error as Error)?.message,
        variant: "error",
      });
      setSubmitting(false);
    }
  };

  if (!open) return null;
  const ownedPackages = (myPackages ?? []) as Array<{
    packageId: string;
    displayName: string;
    description: string;
    category?: StoreCategory;
  }>;

  return (
    <div className="store-publish-dialog">
      <div className="store-publish-dialog-card">
        <div className="store-publish-dialog-title">
          {asUpdate ? "Publish update" : "Publish to Store"}
        </div>

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
            <span>Existing add-on</span>
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
              <span>Name</span>
              <input
                type="text"
                value={displayName}
                onChange={(event) => handleNameChange(event.target.value)}
                placeholder="Cute snake game"
                maxLength={120}
              />
            </label>
            <label className="store-publish-dialog-field">
              <span>Package ID</span>
              <input
                type="text"
                value={packageId}
                onChange={(event) => setPackageId(event.target.value)}
                placeholder="cute-snake-game"
                maxLength={64}
              />
            </label>
            <label className="store-publish-dialog-field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="A short description for the store listing."
                rows={3}
                maxLength={4_000}
              />
            </label>
            <label className="store-publish-dialog-field">
              <span>Category</span>
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
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pill-btn pill-btn-primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blueprint review dialog
// ---------------------------------------------------------------------------

type BlueprintDialogProps = {
  message: StoreThreadMessage;
  /**
   * True only for the most recent non-denied blueprint draft. Older
   * drafts and denied drafts open the dialog read-only — the receiver
   * agent installs from the latest publishable draft, so approving an
   * older one would be misleading.
   */
  canApprove: boolean;
  denying: boolean;
  onClose: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onEdit: () => void;
};

function BlueprintDialog({
  message,
  canApprove,
  denying,
  onClose,
  onApprove,
  onDeny,
  onEdit,
}: BlueprintDialogProps) {
  const denied = Boolean(message.denied);
  return (
    <div className="store-blueprint-dialog">
      <div className="store-blueprint-dialog-card">
        <div className="store-blueprint-dialog-header">
          <div className="store-blueprint-dialog-title">
            Blueprint draft
            {denied ? (
              <span className="store-blueprint-dialog-denied-tag">denied</span>
            ) : null}
          </div>
          <button
            type="button"
            className="store-blueprint-dialog-close"
            onClick={onClose}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="store-blueprint-dialog-body">
          <div className="store-blueprint-dialog-viewer">
            <Markdown
              text={message.text}
              cacheKey={message._id}
              className="store-blueprint-dialog-markdown"
            />
          </div>
          <div className="store-blueprint-dialog-actions">
            <button
              type="button"
              className="pill-btn pill-btn-primary"
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
              Approve & Publish
            </button>
            <button
              type="button"
              className="pill-btn pill-btn-danger"
              onClick={onDeny}
              disabled={!canApprove || denying}
            >
              {denying ? "Denying…" : "Deny"}
            </button>
            <button
              type="button"
              className="pill-btn"
              onClick={onEdit}
              disabled={denying}
            >
              Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

export function StoreSidePanel() {
  const state = useStoreSidePanelState();
  const { hasSession } = useAuthSessionState();
  const thread = useQuery(
    api.data.store_thread.getThread,
    hasSession ? {} : "skip",
  ) as
    | StoreThreadResult
    | undefined;
  const sendMessage = useAction(api.data.store_thread.sendMessage);
  const cancelInFlight = useMutation(api.data.store_thread.cancelInFlightTurn);

  const denyLatestBlueprint = useMutation(
    api.data.store_thread.denyLatestBlueprint,
  );

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  /** Currently-open blueprint review dialog (clicked badge). */
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

  useEffect(() => {
    void refreshFeatureSnapshot();
    void window.electronAPI?.system
      ?.getDeviceId?.()
      .then((nextDeviceId) => setDeviceId(nextDeviceId?.trim() || null))
      .catch(() => setDeviceId(null));
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  const items = state.snapshot?.items ?? [];
  const messages = thread?.messages ?? [];
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

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await cancelInFlight();
    } catch (error) {
      showToast({
        title: "Couldn't stop the agent",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setStopping(false);
    }
  }, [cancelInFlight, stopping]);

  const handleSend = useCallback(async () => {
    const text = composer.trim();
    if (!text || sending) return;
    if (!deviceId) {
      showToast({
        title: "Send failed",
        description: "This device is not ready yet. Try again in a moment.",
        variant: "error",
      });
      return;
    }
    setSending(true);
    try {
      const attachedFeatureNames = Array.from(state.selectedFeatureNames);
      const editingBlueprint = Boolean(editingBlueprintMessage);
      await sendMessage({
        text,
        deviceId,
        ...(attachedFeatureNames.length > 0 ? { attachedFeatureNames } : {}),
        ...(editingBlueprint ? { editingBlueprint: true } : {}),
      });
      setComposer("");
      setEditingBlueprintId(null);
      storeSidePanelStore.clearSelections();
    } catch (error) {
      showToast({
        title: "Send failed",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setSending(false);
    }
  }, [
    composer,
    deviceId,
    editingBlueprintMessage,
    sending,
    sendMessage,
    state.selectedFeatureNames,
  ]);

  const handleApproveBlueprint = useCallback(() => {
    setReviewingMessage(null);
    setPublishOpen(true);
  }, []);

  const handleDenyBlueprint = useCallback(async () => {
    if (denying) return;
    setDenying(true);
    try {
      await denyLatestBlueprint();
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
  }, [denying, denyLatestBlueprint]);

  const handleEditBlueprint = useCallback((message: StoreThreadMessage) => {
    setEditingBlueprintId(message._id);
    setReviewingMessage(null);
  }, []);

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
              <button
                key={`${index}:${item.name}`}
                type="button"
                className="store-side-panel-row"
                data-selected={selected ? "" : undefined}
                onClick={() => storeSidePanelStore.toggleFeature(item.name)}
              >
                <span className="store-side-panel-row-title">{item.name}</span>
                {state.snapshot?.generatedAt ? (
                  <span className="store-side-panel-row-meta">
                    Updated {formatTimeAgo(state.snapshot.generatedAt)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <div className="store-side-panel-thread">
        {messages.length === 0 ? (
          <div className="store-side-panel-empty">
            Pick changes above or just type — the Store agent will help draft a
            blueprint to publish.
          </div>
        ) : (
          messages.map((message) => {
            // Blueprint messages render as a small badge — the full
            // markdown opens in a dialog. Keeps the chat scannable
            // even with several drafts and gives the user explicit
            // approve/deny/edit controls.
            if (message.isBlueprint) {
              return (
                <div
                  key={message._id}
                  className="store-side-panel-message"
                  data-role={message.role}
                  data-blueprint=""
                  data-denied={message.denied ? "" : undefined}
                >
                  <button
                    type="button"
                    className="store-side-panel-blueprint-badge"
                    data-denied={message.denied ? "" : undefined}
                    onClick={() => setReviewingMessage(message)}
                    title="Open blueprint draft"
                  >
                    <FileText size={14} />
                    <span className="store-side-panel-blueprint-badge-label">
                      {message.denied
                        ? "Blueprint draft (denied)"
                        : message.published
                          ? `Blueprint draft (published${
                              message.publishedReleaseNumber
                                ? ` v${message.publishedReleaseNumber}`
                                : ""
                            })`
                        : "Blueprint draft"}
                    </span>
                    <span className="store-side-panel-blueprint-badge-meta">
                      {message.text.length.toLocaleString()} chars
                    </span>
                  </button>
                </div>
              );
            }
            return (
              <div
                key={message._id}
                className="store-side-panel-message"
                data-role={message.role}
                data-pending={message.pending ? "" : undefined}
              >
                {message.attachedFeatureNames &&
                message.attachedFeatureNames.length > 0 ? (
                  <div className="store-side-panel-message-chips">
                    {message.attachedFeatureNames.map((name) => (
                      <span
                        key={name}
                        className="store-side-panel-message-chip"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="store-side-panel-message-text">
                  {message.pending ? (
                    <span className="store-side-panel-message-pending">
                      Working…
                    </span>
                  ) : (
                    message.text
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {(state.selectedFeatureNames.size > 0 || editingBlueprintMessage) ? (
        <div className="store-side-panel-selected-chips">
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
              className="store-side-panel-message-chip"
              onClick={() => storeSidePanelStore.toggleFeature(name)}
              title="Click to remove"
            >
              {name} ×
            </button>
          ))}
        </div>
      ) : null}

      <div className="store-side-panel-composer">
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          placeholder={
            editingBlueprintMessage
              ? "Describe the change you want to the draft…"
              : "What do you want to publish?"
          }
          rows={2}
          disabled={sending || isInFlight}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        {isInFlight ? (
          <button
            type="button"
            className="store-side-panel-send"
            onClick={() => void handleStop()}
            disabled={stopping}
            title="Stop"
          >
            <StopCircle size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="store-side-panel-send"
            onClick={() => void handleSend()}
            disabled={sending || !composer.trim()}
            title="Send"
          >
            <Send size={14} />
          </button>
        )}
      </div>

      {reviewingMessage ? (
        <BlueprintDialog
          message={reviewingMessage}
          canApprove={
            !!latestPublishableBlueprint &&
            latestPublishableBlueprint._id === reviewingMessage._id
          }
          denying={denying}
          onClose={() => setReviewingMessage(null)}
          onApprove={handleApproveBlueprint}
          onDeny={() => void handleDenyBlueprint()}
          onEdit={() => handleEditBlueprint(reviewingMessage)}
        />
      ) : null}

      <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} />
    </div>
  );
}

export default StoreSidePanel;
