import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { getSocialActionErrorMessage } from "./social-errors";
import { useSocialMessages } from "./hooks/use-social-messages";
import { getSocialRoomDisplayName } from "./room-display";
import {
  useSocialSession,
  type SocialSessionStatus,
} from "./hooks/use-social-session";
import { SocialComposer } from "./SocialComposer";
import type { SocialRoomSummary } from "./hooks/use-social-rooms";
import type { SocialProfile } from "./hooks/use-social-profile";
import { useSocialFriends } from "./hooks/use-social-friends";
import {
  getSocialCensorEnabled,
  maskBannedTerms,
} from "./social-censor";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Globe from "lucide-react/dist/esm/icons/globe";
import UserPlus from "lucide-react/dist/esm/icons/user-plus";
import Check from "lucide-react/dist/esm/icons/check";
import Clock from "lucide-react/dist/esm/icons/clock";

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

function getProfileForOwner(
  roomData: SocialRoomSummary,
  extraProfiles: SocialProfile[],
  ownerId: string,
): { nickname: string; avatarUrl?: string; friendCode?: string } {
  const member =
    roomData.memberProfiles.find((profile) => profile.ownerId === ownerId) ??
    extraProfiles.find((profile) => profile.ownerId === ownerId);
  return member ?? { nickname: "Unknown" };
}

export function SocialChatPane({ roomId, currentOwnerId }: SocialChatPaneProps) {
  const roomData = useQuery(api.social.rooms.getRoom, { roomId }) as SocialRoomSummary | null;
  const { messages, sendMessage } = useSocialMessages(roomId);
  const socialSessionsApi = window.electronAPI?.socialSessions;
  const isGlobalRoom = roomData?.room.kind === "global";

  const [censorEnabled, setCensorEnabled] = useState(getSocialCensorEnabled);
  const [sessionLookupId, setSessionLookupId] = useState<string | null>(null);
  const { sessionSummary, turns } = useSocialSession(sessionLookupId);
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

  useEffect(() => {
    const handleChange = () => setCensorEnabled(getSocialCensorEnabled());
    window.addEventListener("stella-social-censor-change", handleChange);
    window.addEventListener("storage", handleChange);
    return () => {
      window.removeEventListener("stella-social-censor-change", handleChange);
      window.removeEventListener("storage", handleChange);
    };
  }, []);

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

  // For Global Chat, the room has no per-user membership preview, so resolve
  // the unique senders of the loaded messages on demand. Stella's sentinel id
  // is excluded — it doesn't have a profile.
  const senderOwnerIds = useMemo(() => {
    if (!isGlobalRoom) return [] as string[];
    const seen = new Set<string>();
    for (const msg of messages) {
      if (
        msg.senderOwnerId !== STELLA_SENDER_OWNER_ID &&
        !seen.has(msg.senderOwnerId)
      ) {
        seen.add(msg.senderOwnerId);
      }
    }
    return [...seen];
  }, [isGlobalRoom, messages]);

  const senderProfiles = useQuery(
    api.social.profiles.getProfilesByOwnerIds,
    isGlobalRoom && senderOwnerIds.length > 0
      ? { ownerIds: senderOwnerIds }
      : "skip",
  ) as SocialProfile[] | undefined;

  const { friends, pendingRequests, sendFriendRequestByOwnerId } =
    useSocialFriends();
  const friendStatusByOwnerId = useMemo(() => {
    const map = new Map<string, "friends" | "outgoing" | "incoming">();
    for (const friend of friends) {
      map.set(friend.profile.ownerId, "friends");
    }
    for (const request of pendingRequests.outgoing) {
      map.set(request.relationship.addresseeOwnerId, "outgoing");
    }
    for (const request of pendingRequests.incoming) {
      map.set(request.relationship.requesterOwnerId, "incoming");
    }
    return map;
  }, [friends, pendingRequests]);

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
        {isGlobalRoom && (
          <div className="social-chat-header-icon" aria-hidden>
            <Globe size={18} />
          </div>
        )}
        <div className="social-chat-header-info">
          <div className="social-chat-header-name">{displayName}</div>
          {isGlobalRoom ? (
            <div className="social-chat-header-meta">
              Public chat for everyone on Stella
            </div>
          ) : (
            roomData.memberProfiles.length > 2 && (
              <div className="social-chat-header-meta">
                {roomData.memberProfiles.length} people
              </div>
            )
          )}
        </div>
        {/*
          Stella Together CTA collapses to a single header pill when no
          session is active — saves a whole row of vertical space below.
          Once a session exists, a compact status bar mounts below the header.
        */}
        {!isGlobalRoom && !activeSession && (
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

      {!isGlobalRoom && activeSession && (
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
        <div className="social-messages-container">
          {messageGroups.length === 0 && (
            <div className="social-empty-state">
              <div className="social-empty-icon">
                <MessageSquare size={22} />
              </div>
              <div className="social-empty-subtitle">
                Say hello to start the conversation
              </div>
            </div>
          )}
          {messageGroups.map((group) => {
            const isSelf = group.senderOwnerId === currentOwnerId;
            const isStella = group.senderOwnerId === STELLA_SENDER_OWNER_ID;
            const isSystem = group.messages[0].kind === "system";
            const profile = isStella
              ? { nickname: "Stella" }
              : getProfileForOwner(
                  roomData,
                  senderProfiles ?? [],
                  group.senderOwnerId,
                );

            if (isSystem) {
              return group.messages.map((msg) => (
                <div key={msg.id} className="social-message-bubble" data-role="system">
                  {censorEnabled ? maskBannedTerms(msg.body) : msg.body}
                </div>
              ));
            }

            const role = isStella ? "stella" : isSelf ? "self" : "other";

            return (
              <div key={group.messages[0].id} className="social-message-group">
                {!isSelf && (
                  <div className="social-message-sender">
                    {isStella ? (
                      <span className="social-message-sender-avatar social-message-sender-avatar--stella">
                        <img src="stella-logo.svg" alt="" />
                      </span>
                    ) : (
                      <Avatar
                        fallback={profile.nickname}
                        src={profile.avatarUrl}
                        size="small"
                      />
                    )}
                    <span
                      className="social-message-sender-name"
                      data-stella={isStella || undefined}
                    >
                      {profile.nickname}
                    </span>
                    {isGlobalRoom && !isStella && (
                      <AddFriendInlineButton
                        targetOwnerId={group.senderOwnerId}
                        status={friendStatusByOwnerId.get(group.senderOwnerId)}
                        sendFriendRequest={sendFriendRequestByOwnerId}
                      />
                    )}
                    <span className="social-message-sender-time">
                      {formatMessageTime(group.firstTimestamp)}
                    </span>
                  </div>
                )}
                {isSelf && (
                  <div className="social-message-sender" style={{ justifyContent: "flex-end" }}>
                    <span className="social-message-sender-time">
                      {formatMessageTime(group.firstTimestamp)}
                    </span>
                  </div>
                )}
                {group.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="social-message-bubble"
                    data-role={role}
                    data-pending={msg.pending || undefined}
                  >
                    {censorEnabled ? maskBannedTerms(msg.body) : msg.body}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
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
              : isGlobalRoom
                ? "Say something to Global Chat..."
                : `Message ${displayName}`
          }
        />
      </div>
    </div>
  );
}

type FriendStatus = "friends" | "outgoing" | "incoming" | undefined;

function AddFriendInlineButton({
  targetOwnerId,
  status,
  sendFriendRequest,
}: {
  targetOwnerId: string;
  status: FriendStatus;
  sendFriendRequest: (targetOwnerId: string) => Promise<unknown>;
}) {
  // Optimistic local override so the chip flips to "Requested" immediately
  // even before the friends/pending queries refresh.
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const effectiveStatus: FriendStatus =
    status ?? (optimisticPending ? "outgoing" : undefined);

  const handleClick = useCallback(async () => {
    if (isSending) return;
    if (effectiveStatus === "friends" || effectiveStatus === "outgoing") return;
    setIsSending(true);
    try {
      await sendFriendRequest(targetOwnerId);
      setOptimisticPending(true);
      showToast({
        variant: "success",
        description: "Friend request sent.",
      });
    } catch (error) {
      showToast({
        variant: "error",
        description: getSocialActionErrorMessage(
          "Couldn't send friend request. Please try again.",
          error,
        ),
      });
    } finally {
      setIsSending(false);
    }
  }, [effectiveStatus, isSending, sendFriendRequest, targetOwnerId]);

  if (effectiveStatus === "friends") {
    return (
      <span className="social-friend-chip" data-status="friends" title="Friends">
        <Check size={11} aria-hidden />
        Friends
      </span>
    );
  }
  if (effectiveStatus === "incoming") {
    return (
      <span
        className="social-friend-chip"
        data-status="incoming"
        title="They sent you a friend request — open Friends to accept."
      >
        Wants to be friends
      </span>
    );
  }
  if (effectiveStatus === "outgoing") {
    return (
      <span
        className="social-friend-chip"
        data-status="outgoing"
        title="Friend request sent"
      >
        <Clock size={11} aria-hidden />
        Requested
      </span>
    );
  }

  return (
    <button
      type="button"
      className="social-friend-chip social-friend-chip--action"
      onClick={() => void handleClick()}
      disabled={isSending}
      title="Send a friend request"
    >
      <UserPlus size={11} aria-hidden />
      {isSending ? "Sending..." : "Add friend"}
    </button>
  );
}
