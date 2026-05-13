import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import { api } from "@/convex/api";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import { getSocialActionErrorMessage } from "./social-errors";
import { useSocialMessages } from "./hooks/use-social-messages";
import { useSocialRooms } from "./hooks/use-social-rooms";
import { getSocialRoomDisplayName } from "./room-display";
import {
  useSocialSession,
  type SocialSessionStatus,
} from "./hooks/use-social-session";
import { SocialComposer } from "./SocialComposer";
import type { SocialRoomSummary } from "./hooks/use-social-rooms";
import type { SocialProfile } from "./hooks/use-social-profile";
import { MessageSquare } from "lucide-react";
import { AddonShareCard } from "@/global/store/AddonShareCard";
import { parseShareLink } from "@/global/store/share-link";

type SocialChatPaneProps = {
  roomId: string;
  currentOwnerId: string;
};

type MessageDoc = {
  _id: string;
  senderOwnerId: string;
  kind: string;
  body: string;
  createdAt: number;
};

// Sentinel sender id used to mark synthesized "Stella" rows in the unified
// chat timeline. Real owner ids come from Convex auth (`identity.tokenIdentifier`)
// and are URLs/UUIDs, so this string can never collide with a real owner.
const STELLA_SENDER_OWNER_ID = "__stella__";

type TimelineRow = {
  id: string;
  senderOwnerId: string;
  body: string;
  createdAt: number;
  kind: "text" | "system";
  /** Stella turn that hasn't completed yet — used to dim the bubble. */
  pending?: boolean;
};

function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * 16-px spacer rendered between adjacent virtualized groups. Replaces
 * the prior `.social-message-group + .social-message-group { margin-top }`
 * sibling rule, which no longer matches once each group is its own
 * virtualized list item rendered in isolation.
 */
const SocialItemSeparator = () => (
  <div style={{ height: 16 }} aria-hidden="true" />
);

function getProfileForOwner(
  roomData: SocialRoomSummary,
  extraProfiles: SocialProfile[],
  ownerId: string,
): { username: string; avatarUrl?: string } {
  const member =
    roomData.memberProfiles.find((profile) => profile.ownerId === ownerId) ??
    extraProfiles.find((profile) => profile.ownerId === ownerId);
  return member ?? { username: "unknown" };
}

export function SocialChatPane({
  roomId,
  currentOwnerId,
}: SocialChatPaneProps) {
  const roomData = useQuery(api.social.rooms.getRoom, {
    roomId,
  }) as SocialRoomSummary | null;
  const {
    messages,
    sendMessage,
    loadOlder: loadOlderMessages,
    hasOlder: hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
  } = useSocialMessages(roomId, currentOwnerId);
  const { markRead } = useSocialRooms();

  // Drive the unread badge: every time the room's newest visible message id
  // changes (open, new incoming message, send), bump `lastReadAt` on the
  // server so this room drops out of the sidebar/Friends counts. Empty rooms
  // with a stale creation timestamp are marked read without a message id.
  // We depend on the *primitive* last-message id (and the empty-room
  // case's primitive timestamps), not the `messages` array reference —
  // every Convex tick allocates a new array, which would otherwise refire
  // `markRead` per tick even when the visible head hasn't moved.
  const lastMessageId =
    messages.length > 0
      ? (messages as MessageDoc[])[messages.length - 1]._id
      : null;
  const latestMessageAt = roomData?.room.latestMessageAt;
  const lastReadAt = roomData?.membership.lastReadAt;

  useEffect(() => {
    if (lastMessageId !== null) {
      void markRead(roomId, lastMessageId).catch(() => {
        // Read-marker writes are best-effort; the next render will retry.
      });
      return;
    }
    if (latestMessageAt === undefined) return;
    if (lastReadAt !== undefined && latestMessageAt <= lastReadAt) return;
    void markRead(roomId).catch(() => {
      // Read-marker writes are best-effort; the next render will retry.
    });
  }, [lastMessageId, latestMessageAt, lastReadAt, markRead, roomId]);
  const socialSessionsApi = window.electronAPI?.socialSessions;

  const [sessionLookupId, setSessionLookupId] = useState<string | null>(null);
  const {
    sessionSummary,
    turns,
    loadOlderTurns,
    hasOlderTurns,
    isLoadingOlderTurns,
  } = useSocialSession(sessionLookupId);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [isUpdatingSession, setIsUpdatingSession] = useState(false);
  const [armedForStella, setArmedForStella] = useState(false);

  useEffect(() => {
    setSessionLookupId(null);
    setArmedForStella(false);
  }, [roomId]);

  useEffect(() => {
    if (!roomData?.room.stellaSessionId) {
      return;
    }
    setSessionLookupId(roomData.room.stellaSessionId);
  }, [roomData?.room.stellaSessionId]);

  const activeSession = sessionSummary?.session ?? null;
  const isHost = sessionSummary?.isHost === true;
  const sessionIsLive = activeSession?.status === "active";
  const stellaArmed = armedForStella && sessionIsLive;

  // Disarm whenever the session can no longer accept Stella turns.
  useEffect(() => {
    if (armedForStella && !sessionIsLive) {
      setArmedForStella(false);
    }
  }, [armedForStella, sessionIsLive]);

  // Unified timeline: chat messages + every Stella turn projected into two
  // synthetic rows (the user's prompt as a regular message, then Stella's
  // response). Sorted by `createdAt` so everyone in the room sees the same
  // shared conversation regardless of which path created which row.
  const timelineRows = useMemo<TimelineRow[]>(() => {
    const rows: TimelineRow[] = (messages as MessageDoc[]).map((msg) => ({
      id: msg._id,
      senderOwnerId: msg.senderOwnerId,
      body: msg.body,
      createdAt: msg.createdAt,
      kind: msg.kind === "system" ? "system" : "text",
    }));
    for (const turn of turns) {
      if (turn.status === "canceled") continue;
      rows.push({
        id: `${turn._id}:prompt`,
        senderOwnerId: turn.requestedByOwnerId,
        body: turn.prompt,
        createdAt: turn.createdAt,
        kind: "text",
      });
      const responseBody =
        turn.status === "completed"
          ? turn.resultText || "Stella finished without a reply."
          : turn.status === "failed"
            ? turn.error || "Stella couldn't finish that request."
            : "Stella is thinking...";
      rows.push({
        id: `${turn._id}:response`,
        senderOwnerId: STELLA_SENDER_OWNER_ID,
        body: responseBody,
        createdAt: turn.completedAt ?? turn.createdAt + 1,
        kind: "text",
        pending: turn.status === "queued" || turn.status === "claimed",
      });
    }
    rows.sort((left, right) => left.createdAt - right.createdAt);
    return rows;
  }, [messages, turns]);

  const messageGroups = useMemo(() => {
    if (!timelineRows.length) return [];

    const groups: Array<{
      senderOwnerId: string;
      firstTimestamp: number;
      messages: TimelineRow[];
    }> = [];

    for (const row of timelineRows) {
      const last = groups[groups.length - 1];
      if (
        last &&
        last.senderOwnerId === row.senderOwnerId &&
        row.kind !== "system" &&
        last.messages[0].kind !== "system" &&
        row.createdAt - last.messages[last.messages.length - 1].createdAt <
          120_000
      ) {
        last.messages.push(row);
      } else {
        groups.push({
          senderOwnerId: row.senderOwnerId,
          firstTimestamp: row.createdAt,
          messages: [row],
        });
      }
    }

    return groups;
  }, [timelineRows]);

  // Pagination wiring — auto-fetch older history. The room timeline
  // merges chat messages with Stella turns, so a single `onStartReached`
  // signal from the virtualized list drives both `loadOlderMessages`
  // and `loadOlderTurns` whenever the user scrolls near the top.
  //
  // Scroll-position preservation across prepends is handled by Legend
  // List's `maintainVisibleContentPosition` (replaces the previous
  // `column-reverse` + browser `overflow-anchor: auto` trick). The list
  // also owns sticky-bottom via `maintainScrollAtEnd` +
  // `initialScrollAtEnd`.
  const isLoadingOlder = isLoadingOlderMessages || isLoadingOlderTurns;
  const hasOlder = hasOlderMessages || hasOlderTurns;

  const requestOlder = useCallback(() => {
    if (hasOlderMessages) loadOlderMessages();
    if (hasOlderTurns) loadOlderTurns();
  }, [hasOlderMessages, hasOlderTurns, loadOlderMessages, loadOlderTurns]);

  const socialScroll = useChatScrollManagement({
    hasOlderEvents: hasOlder,
    isLoadingOlder,
    onLoadOlder: requestOlder,
  });

  /**
   * Each `messageGroups` entry becomes one virtualized list item: a
   * sender-grouped block of bubbles (header + 1..N bubbles, or a single
   * system bubble). System messages always live in their own group of
   * one because the grouping logic forbids merging across `kind`.
   */
  const renderGroup = useCallback(
    ({
      item: group,
    }: LegendListRenderItemProps<(typeof messageGroups)[number]>) => {
      if (!roomData) return null;

      const isSelf = group.senderOwnerId === currentOwnerId;
      const isStella = group.senderOwnerId === STELLA_SENDER_OWNER_ID;
      const isSystem = group.messages[0].kind === "system";
      const profile = isStella
        ? { username: "Stella" }
        : getProfileForOwner(roomData, [], group.senderOwnerId);

      if (isSystem) {
        const msg = group.messages[0];
        return (
          <div
            key={msg.id}
            className="social-message-bubble"
            data-role="system"
          >
            {msg.body}
          </div>
        );
      }

      const role = isStella ? "stella" : isSelf ? "self" : "other";

      return (
        <div className="social-message-group">
          {!isSelf && (
            <div className="social-message-sender">
              {isStella ? (
                <span className="social-message-sender-avatar social-message-sender-avatar--stella">
                  <img src="stella-logo.svg" alt="" />
                </span>
              ) : (
                <Avatar
                  fallback={profile.username}
                  src={profile.avatarUrl}
                  size="small"
                />
              )}
              <span
                className="social-message-sender-name"
                data-stella={isStella || undefined}
              >
                {isStella ? "Stella" : `@${profile.username}`}
              </span>
              <span className="social-message-sender-time">
                {formatMessageTime(group.firstTimestamp)}
              </span>
            </div>
          )}
          {isSelf && (
            <div
              className="social-message-sender"
              style={{ justifyContent: "flex-end" }}
            >
              <span className="social-message-sender-time">
                {formatMessageTime(group.firstTimestamp)}
              </span>
            </div>
          )}
          {group.messages.map((msg) => {
            // Whole-body Stella share links render as an embedded
            // add-on card instead of a plain text bubble. The bubble
            // gets `data-embed` so the CSS strips its padding/bg and
            // lets the card become the message.
            const shareLink = parseShareLink(msg.body);
            return (
              <div
                key={msg.id}
                className="social-message-bubble"
                data-role={role}
                data-pending={msg.pending || undefined}
                data-embed={shareLink ? "addon-share" : undefined}
              >
                {shareLink ? (
                  <AddonShareCard link={shareLink} variant="wide" />
                ) : (
                  msg.body
                )}
              </div>
            );
          })}
        </div>
      );
    },
    [currentOwnerId, roomData],
  );

  const groupKeyExtractor = useCallback(
    (group: (typeof messageGroups)[number]) => group.messages[0].id,
    [],
  );

  const displayName = roomData
    ? getSocialRoomDisplayName(roomData, currentOwnerId)
    : "";

  const handleStartSession = useCallback(async () => {
    if (!roomData) {
      return;
    }
    if (!socialSessionsApi) {
      showToast({
        variant: "error",
        description: "Shared Stella isn't available in this app session.",
      });
      return;
    }
    setIsStartingSession(true);
    try {
      await socialSessionsApi.create({
        roomId,
        workspaceLabel: displayName,
      });
    } catch (error) {
      showToast({
        variant: "error",
        description: getSocialActionErrorMessage(
          "Couldn't start Stella here. Please try again.",
          error,
        ),
      });
    } finally {
      setIsStartingSession(false);
    }
  }, [displayName, roomData, roomId, socialSessionsApi]);

  const handleUpdateSessionStatus = useCallback(
    async (status: SocialSessionStatus) => {
      if (!activeSession) {
        return;
      }
      if (!socialSessionsApi) {
        showToast({
          variant: "error",
          description: "Shared Stella isn't available in this app session.",
        });
        return;
      }
      setIsUpdatingSession(true);
      try {
        await socialSessionsApi.updateStatus({
          sessionId: activeSession._id,
          status,
        });
      } catch (error) {
        showToast({
          variant: "error",
          description: getSocialActionErrorMessage(
            "Couldn't update Stella right now. Please try again.",
            error,
          ),
        });
      } finally {
        setIsUpdatingSession(false);
      }
    },
    [activeSession, socialSessionsApi],
  );

  // Single composer entry point — routes to Stella when armed (and a live
  // session exists), otherwise falls through to a regular chat message.
  const handleSend = useCallback(
    async (body: string) => {
      if (stellaArmed && activeSession && socialSessionsApi) {
        try {
          await socialSessionsApi.queueTurn({
            sessionId: activeSession._id,
            prompt: body,
            clientTurnId: `social-stella-${Date.now()}`,
          });
          setArmedForStella(false);
        } catch (error) {
          showToast({
            variant: "error",
            description: getSocialActionErrorMessage(
              "Couldn't send that to Stella. Please try again.",
              error,
            ),
          });
        }
        return;
      }
      try {
        await sendMessage(body);
      } catch (error) {
        showToast({
          variant: "error",
          description: getSocialActionErrorMessage(
            "Couldn't send your message. Please try again.",
            error,
          ),
        });
      }
    },
    [activeSession, sendMessage, socialSessionsApi, stellaArmed],
  );

  if (!roomData) {
    return <div className="social-chat-pane" />;
  }

  return (
    <div className="social-chat-pane">
      <div className="social-chat-header">
        <div className="social-chat-header-info">
          <div className="social-chat-header-name">{displayName}</div>
          {roomData.memberProfiles.length > 2 && (
            <div className="social-chat-header-meta">
              {roomData.memberProfiles.length} people
            </div>
          )}
        </div>
        {/*
          Stella Together CTA collapses to a single header pill when no
          session is active — saves a whole row of vertical space below.
          Once a session exists, a compact status bar mounts below the header.
        */}
        {!activeSession && (
          <button
            type="button"
            className="social-stella-pill"
            onClick={() => void handleStartSession()}
            disabled={isStartingSession}
            title="Bring Stella into this conversation"
          >
            <img
              src="stella-logo.svg"
              alt=""
              className="social-stella-pill-logo"
            />
            <span>{isStartingSession ? "Starting..." : "Start Stella"}</span>
          </button>
        )}
      </div>

      {activeSession && (
        <div className="social-session-bar" data-state={activeSession.status}>
          <div className="social-session-bar-info">
            <img
              src="stella-logo.svg"
              alt=""
              className="social-session-header-logo"
            />
            <span
              className="social-session-badge"
              data-status={activeSession.status}
            >
              {activeSession.status === "active"
                ? "Stella · Live"
                : activeSession.status === "paused"
                  ? "Stella · Paused"
                  : "Stella · Ended"}
            </span>
            <span className="social-session-header-hint">
              {activeSession.status === "active"
                ? "Anyone here can tell Stella."
                : activeSession.status === "paused"
                  ? "Paused — resume to tell Stella again."
                  : "This shared Stella space has ended."}
            </span>
          </div>
          <div className="social-session-actions">
            {activeSession.status === "ended" ? (
              <button
                type="button"
                className="social-session-button"
                onClick={() => void handleStartSession()}
                disabled={isStartingSession}
              >
                {isStartingSession ? "Starting..." : "Start Again"}
              </button>
            ) : null}
            {isHost && activeSession.status !== "ended" ? (
              <>
                <button
                  type="button"
                  className="social-session-button"
                  onClick={() =>
                    void handleUpdateSessionStatus(
                      activeSession.status === "active" ? "paused" : "active",
                    )
                  }
                  disabled={isUpdatingSession}
                >
                  {activeSession.status === "active" ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  className="social-session-button"
                  data-variant="danger"
                  onClick={() => void handleUpdateSessionStatus("ended")}
                  disabled={isUpdatingSession}
                >
                  End
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}

      <div className="social-messages-viewport">
        {messageGroups.length === 0 ? (
          <div className="social-empty-state">
            <div className="social-empty-icon">
              <MessageSquare size={22} />
            </div>
            <div className="social-empty-subtitle">
              Say hello to start the conversation
            </div>
          </div>
        ) : (
          <LegendList
            ref={socialScroll.listRef}
            data={messageGroups}
            keyExtractor={groupKeyExtractor}
            renderItem={renderGroup}
            estimatedItemSize={60}
            recycleItems
            maintainVisibleContentPosition
            maintainScrollAtEnd={{ animated: false }}
            maintainScrollAtEndThreshold={0.02}
            initialScrollAtEnd
            onScroll={socialScroll.onListScroll}
            onStartReached={socialScroll.onStartReached}
            onStartReachedThreshold={0.5}
            ListHeaderComponent={
              isLoadingOlder ? (
                <div
                  className="social-messages-older-loading"
                  aria-live="polite"
                >
                  Loading older messages…
                </div>
              ) : undefined
            }
            ItemSeparatorComponent={SocialItemSeparator}
            className="social-messages-list"
            contentContainerStyle={{ padding: 24 }}
            style={{ height: "100%", width: "100%" }}
          />
        )}
      </div>

      <div className="social-composer-stack">
        {sessionIsLive && (
          <button
            type="button"
            className="social-stella-arm-button"
            data-active={stellaArmed || undefined}
            onClick={() => setArmedForStella((v) => !v)}
            title={
              stellaArmed
                ? "Send the next message as a normal chat message"
                : "Send the next message to Stella"
            }
          >
            <img
              src="stella-logo.svg"
              alt=""
              className="social-stella-arm-button-logo"
            />
            <span>{stellaArmed ? "Telling Stella" : "Tell Stella"}</span>
          </button>
        )}
        <SocialComposer
          onSend={handleSend}
          armed={stellaArmed}
          placeholder={
            stellaArmed
              ? "Tell Stella what you want..."
              : `Message ${displayName}`
          }
        />
      </div>
    </div>
  );
}
