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
  type SocialSessionTurn,
} from "./hooks/use-social-session";
import { SocialComposer } from "./SocialComposer";
import type { SocialRoomSummary } from "./hooks/use-social-rooms";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";

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

function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getProfileForOwner(
  roomData: SocialRoomSummary,
  ownerId: string,
): { nickname: string; avatarUrl?: string } {
  const member = roomData.memberProfiles.find((profile) => profile.ownerId === ownerId);
  return member ?? { nickname: "Unknown" };
}

export function SocialChatPane({ roomId, currentOwnerId }: SocialChatPaneProps) {
  const roomData = useQuery(api.social.rooms.getRoom, { roomId }) as SocialRoomSummary | null;
  const { messages, sendMessage } = useSocialMessages(roomId);
  const socialSessionsApi = window.electronAPI?.socialSessions;
  const [sessionLookupId, setSessionLookupId] = useState<string | null>(null);
  const { sessionSummary, turns } = useSocialSession(sessionLookupId);
  const [stellaPrompt, setStellaPrompt] = useState("");
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [isUpdatingSession, setIsUpdatingSession] = useState(false);
  const [isSendingTurn, setIsSendingTurn] = useState(false);

  useEffect(() => {
    setSessionLookupId(null);
  }, [roomId]);

  useEffect(() => {
    if (!roomData?.room.stellaSessionId) {
      return;
    }
    setSessionLookupId(roomData.room.stellaSessionId);
  }, [roomData?.room.stellaSessionId]);

  const messageGroups = useMemo(() => {
    if (!messages.length) return [];

    const groups: Array<{
      senderOwnerId: string;
      firstTimestamp: number;
      messages: MessageDoc[];
    }> = [];

    const ordered = [...messages].reverse();

    for (const msg of ordered) {
      const last = groups[groups.length - 1];
      if (
        last &&
        last.senderOwnerId === msg.senderOwnerId &&
        msg.kind !== "system" &&
        last.messages[0].kind !== "system" &&
        msg.createdAt - last.messages[last.messages.length - 1].createdAt < 120_000
      ) {
        last.messages.push(msg);
      } else {
        groups.push({
          senderOwnerId: msg.senderOwnerId,
          firstTimestamp: msg.createdAt,
          messages: [msg],
        });
      }
    }

    return groups;
  }, [messages]);

  const displayName = roomData
    ? getSocialRoomDisplayName(roomData, currentOwnerId)
    : "";
  const activeSession = sessionSummary?.session ?? null;
  const isHost = sessionSummary?.isHost === true;

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

  const handleSendStellaTurn = useCallback(async () => {
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
    const prompt = stellaPrompt.trim();
    if (!prompt) {
      return;
    }
    setIsSendingTurn(true);
    try {
      await socialSessionsApi.queueTurn({
        sessionId: activeSession._id,
        prompt,
        clientTurnId: `social-stella-${Date.now()}`,
      });
      setStellaPrompt("");
    } catch (error) {
      showToast({
        variant: "error",
        description: getSocialActionErrorMessage(
          "Couldn't send that to Stella. Please try again.",
          error,
        ),
      });
    } finally {
      setIsSendingTurn(false);
    }
  }, [activeSession, socialSessionsApi, stellaPrompt]);

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
      </div>

      <div className="social-session-panel">
        <div className="social-session-header">
          <div>
            <div className="social-session-title">Stella Together</div>
            <div className="social-session-subtitle">
              {activeSession
                ? activeSession.status === "active"
                  ? "Anyone here can ask Stella and share the response."
                  : activeSession.status === "paused"
                    ? "This shared Stella space is paused."
                    : "This shared Stella space has ended."
                : "Bring Stella into this conversation when you want shared help."}
            </div>
          </div>
          <div className="social-session-actions">
            {activeSession ? (
              <>
                <span className="social-session-badge" data-status={activeSession.status}>
                  {activeSession.status === "active"
                    ? "Live"
                    : activeSession.status === "paused"
                      ? "Paused"
                      : "Ended"}
                </span>
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
              </>
            ) : (
              <button
                type="button"
                className="social-session-button"
                onClick={() => void handleStartSession()}
                disabled={isStartingSession}
              >
                {isStartingSession ? "Starting..." : "Start Stella"}
              </button>
            )}
          </div>
        </div>

        {activeSession && activeSession.status !== "ended" ? (
          <div className="social-session-composer">
            <textarea
              className="social-session-input"
              placeholder={
                activeSession.status === "active"
                  ? "Ask Stella something for this conversation..."
                  : "Resume Stella to ask another question..."
              }
              value={stellaPrompt}
              onChange={(event) => setStellaPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendStellaTurn();
                }
              }}
              rows={1}
              disabled={activeSession.status !== "active" || isSendingTurn}
            />
            <button
              type="button"
              className="social-session-button"
              onClick={() => void handleSendStellaTurn()}
              disabled={
                activeSession.status !== "active" ||
                isSendingTurn ||
                stellaPrompt.trim().length === 0
              }
            >
              {isSendingTurn ? "Sending..." : "Ask Stella"}
            </button>
          </div>
        ) : null}

        {turns.length > 0 ? (
          <div className="social-session-turns">
            {[...turns]
              .sort((left, right) => left.ordinal - right.ordinal)
              .map((turn) => {
                const isMine = turn.requestedByOwnerId === currentOwnerId;
                return (
                  <SocialSessionTurnRow
                    key={turn._id}
                    turn={turn}
                    isMine={isMine}
                  />
                );
              })}
          </div>
        ) : activeSession ? (
          <div className="social-session-empty">
            No shared Stella replies yet.
          </div>
        ) : null}
      </div>

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
            const isSystem = group.messages[0].kind === "system";
            const profile = getProfileForOwner(roomData, group.senderOwnerId);

            if (isSystem) {
              return group.messages.map((msg) => (
                <div key={msg._id} className="social-message-bubble" data-role="system">
                  {msg.body}
                </div>
              ));
            }

            return (
              <div key={group.messages[0]._id} className="social-message-group">
                {!isSelf && (
                  <div className="social-message-sender">
                    <Avatar
                      fallback={profile.nickname}
                      src={profile.avatarUrl}
                      size="small"
                    />
                    <span className="social-message-sender-name">
                      {profile.nickname}
                    </span>
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
                    key={msg._id}
                    className="social-message-bubble"
                    data-role={isSelf ? "self" : "other"}
                  >
                    {msg.body}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <SocialComposer onSend={sendMessage} />
    </div>
  );
}

function SocialSessionTurnRow({
  turn,
  isMine,
}: {
  turn: SocialSessionTurn;
  isMine: boolean;
}) {
  return (
    <div className="social-session-turn">
      <div className="social-session-turn-label">
        {isMine ? "You asked Stella" : "A friend asked Stella"}
      </div>
      <div className="social-session-turn-prompt">{turn.prompt}</div>
      <div className="social-session-turn-response" data-status={turn.status}>
        {turn.status === "completed"
          ? turn.resultText || "Stella finished without a reply."
          : turn.status === "failed"
            ? turn.error || "Stella couldn't finish that request."
            : turn.status === "canceled"
              ? "This Stella request was canceled."
              : "Stella is thinking..."}
      </div>
    </div>
  );
}
