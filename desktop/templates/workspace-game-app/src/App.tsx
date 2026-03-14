/**
 * Game app root.
 *
 * Handles the hosted launch handshake, registers the player with the Stella
 * game runtime, and routes between lobby and active play.
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { reducers, tables } from "./bindings";
import { Lobby } from "./components/Lobby";
import { GameView } from "./components/GameView";
import {
  clearHostedLaunchAuth,
  decodeHostedGameToken,
  getJoinCodeFromUrl,
  getLaunchDisplayName,
  getLaunchGameToken,
  getSessionFromUrl,
  isHostedGameAuthMessage,
  saveActiveSessionId,
  saveHostedLaunchAuth,
} from "./lib/session";

const NO_GAME_ID = "__stella:no-game__";
const NO_USER_ID = "__stella:no-user__";
const NO_SESSION_USER_ID = "__stella:no-session__";

type LaunchAuthState =
  | { status: "waiting"; displayName?: string }
  | { status: "ready"; gameToken: string; displayName?: string }
  | { status: "blocked"; displayName?: string };

function parseSessionId(value: string | null): bigint | null {
  if (!value) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function useHostedLaunchAuth(): LaunchAuthState {
  const [state, setState] = useState<LaunchAuthState>(() => {
    const gameToken = getLaunchGameToken();
    const displayName = getLaunchDisplayName();
    if (gameToken) {
      return {
        status: "ready",
        gameToken,
        ...(displayName ? { displayName } : {}),
      };
    }
    return { status: "waiting", ...(displayName ? { displayName } : {}) };
  });

  useEffect(() => {
    const receiveAuth = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return;
      }
      if (!isHostedGameAuthMessage(event.data)) {
        return;
      }

      saveHostedLaunchAuth(event.data);
      setState({
        status: "ready",
        gameToken: event.data.gameToken,
        ...(event.data.displayName ? { displayName: event.data.displayName } : {}),
      });
    };

    window.addEventListener("message", receiveAuth);

    const blockTimer = window.setTimeout(() => {
      const gameToken = getLaunchGameToken();
      if (gameToken) {
        setState({
          status: "ready",
          gameToken,
          ...(getLaunchDisplayName()
            ? { displayName: getLaunchDisplayName()! }
            : {}),
        });
        return;
      }

      if (window.parent === window) {
        clearHostedLaunchAuth();
        setState({
          status: "blocked",
          ...(getLaunchDisplayName()
            ? { displayName: getLaunchDisplayName()! }
            : {}),
        });
      }
    }, 1500);

    return () => {
      window.removeEventListener("message", receiveAuth);
      window.clearTimeout(blockTimer);
    };
  }, []);

  return state;
}

function GameRouter() {
  const launchAuth = useHostedLaunchAuth();
  const { isActive, identity } = useSpacetimeDB();
  const requestedSessionId = parseSessionId(getSessionFromUrl());
  const joinCode = getJoinCodeFromUrl()?.trim().toUpperCase() ?? "";
  const launchContext = useMemo(
    () =>
      launchAuth.status === "ready"
        ? decodeHostedGameToken(launchAuth.gameToken)
        : null,
    [launchAuth],
  );
  const gameId = launchContext?.gameId ?? NO_GAME_ID;
  const userId = launchContext?.userId ?? NO_USER_ID;

  const [sessions] = useTable(
    tables.sessions.where((row) => row.gameId.eq(gameId)),
  );
  const [membershipPlayers] = useTable(
    requestedSessionId !== null
      ? tables.players.where((row) => row.sessionId.eq(requestedSessionId))
      : tables.players.where((row) => row.userId.eq(userId)),
  );

  const session = useMemo(() => {
    if (requestedSessionId !== null) {
      return (
        sessions.find((candidate) => candidate.sessionId === requestedSessionId) ??
        null
      );
    }

    const sessionIds = new Set(
      membershipPlayers.map((player) => player.sessionId.toString()),
    );

    return (
      sessions
        .filter((candidate) => sessionIds.has(candidate.sessionId.toString()))
        .sort((left, right) =>
          left.updatedAt === right.updatedAt
            ? 0
            : left.updatedAt > right.updatedAt
              ? -1
              : 1,
        )[0] ?? null
    );
  }, [membershipPlayers, requestedSessionId, sessions]);

  const [sessionPlayers] = useTable(
    session
      ? tables.players.where((row) => row.sessionId.eq(session.sessionId))
      : tables.players.where((row) => row.userId.eq(NO_SESSION_USER_ID)),
  );

  const myPlayer = useMemo(() => {
    if (!session) {
      return null;
    }

    return (
      sessionPlayers.find((player) =>
        identity
          ? player.playerIdentity.isEqual(identity)
          : player.userId === userId,
      ) ?? null
    );
  }, [identity, session, sessionPlayers, userId]);

  const startSession = useReducer(reducers.startSession);
  const startTickLoop = useReducer(reducers.startTickLoop);
  const isHost = myPlayer?.isHost ?? false;

  useEffect(() => {
    if (session) {
      saveActiveSessionId(session.sessionId);
    }
  }, [session]);

  const handleStartGame = useCallback(async () => {
    if (!session) {
      return;
    }

    await startSession({ sessionId: session.sessionId });
    await startTickLoop({ sessionId: session.sessionId });
  }, [session, startSession, startTickLoop]);

  if (launchAuth.status === "blocked") {
    return <LaunchBlocked displayName={launchAuth.displayName} />;
  }

  if (launchAuth.status === "waiting") {
    return <WaitingForStella displayName={launchAuth.displayName} />;
  }

  if (!isActive) {
    return (
      <div style={styles.connecting}>
        <div style={styles.spinner} />
        <span>Connecting...</span>
      </div>
    );
  }

  if (!session || !myPlayer) {
    return <JoinOrCreate joinCode={joinCode} launchAuth={launchAuth} />;
  }

  if (session.lifecycleState === "lobby") {
    return (
      <Lobby
        sessionId={session.sessionId}
        joinCode={session.joinCode}
        isHost={isHost}
        onStartGame={handleStartGame}
      />
    );
  }

  return (
    <GameView
      sessionId={session.sessionId}
      playerSlot={Number(myPlayer.slot)}
      isHost={isHost}
    />
  );
}

function JoinOrCreate({
  joinCode: initialJoinCode,
  launchAuth,
}: {
  joinCode: string;
  launchAuth: Extract<LaunchAuthState, { status: "ready" }>;
}) {
  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [error, setError] = useState<string | null>(null);
  const registerPlayer = useReducer(reducers.registerPlayer);
  const joinSession = useReducer(reducers.joinSession);
  const createSession = useReducer(reducers.createSession);
  const displayName = useMemo(
    () => launchAuth.displayName ?? getLaunchDisplayName() ?? "Player",
    [launchAuth.displayName],
  );

  const ensureRegistered = useCallback(async () => {
    await registerPlayer({
      gameToken: launchAuth.gameToken,
    });
  }, [launchAuth.gameToken, registerPlayer]);

  const handleJoin = useCallback(async () => {
    if (!joinCode.trim()) {
      return;
    }

    setError(null);
    try {
      await ensureRegistered();
      await joinSession({
        joinCode: joinCode.trim().toUpperCase(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join");
    }
  }, [ensureRegistered, joinCode, joinSession]);

  const handleCreate = useCallback(async () => {
    setError(null);
    try {
      await ensureRegistered();
      await createSession({
        gameType: "custom",
        rulesetKey: "generated",
        minPlayers: 2,
        maxPlayers: 8,
        runtimeKind: "authoritative",
        tickRateHz: 20,
        snapshotRateHz: 20,
        interestMode: "session",
        partitionSize: 32,
        publicStateJson: "{}",
        metadataJson: "{}",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    }
  }, [createSession, ensureRegistered]);

  return (
    <div style={styles.joinContainer}>
      <div style={styles.joinCard}>
        <h2 style={styles.joinTitle}>{{name}}</h2>
        <div style={styles.signedInAs}>Signed in as {displayName}</div>

        <div style={styles.divider} />

        <input
          type="text"
          placeholder="Join code (e.g. W3KN)"
          value={joinCode}
          onChange={(event) =>
            setJoinCode(event.target.value.toUpperCase())
          }
          maxLength={4}
          style={{
            ...styles.input,
            textAlign: "center",
            letterSpacing: "0.2em",
            fontSize: 20,
          }}
        />
        <button
          onClick={handleJoin}
          disabled={!joinCode.trim()}
          style={styles.primaryButton}
        >
          Join Game
        </button>

        <div style={styles.orText}>or</div>

        <button onClick={handleCreate} style={styles.secondaryButton}>
          Create New Game
        </button>

        {error ? <div style={styles.error}>{error}</div> : null}
      </div>
    </div>
  );
}

function WaitingForStella({ displayName }: { displayName?: string }) {
  return (
    <div style={styles.connecting}>
      <div style={styles.spinner} />
      <span>Waiting for Stella to authorize this game...</span>
      {displayName ? (
        <span style={styles.helperText}>Signed in as {displayName}</span>
      ) : null}
    </div>
  );
}

function LaunchBlocked({ displayName }: { displayName?: string }) {
  return (
    <div style={styles.joinContainer}>
      <div style={styles.joinCard}>
        <h2 style={styles.joinTitle}>Open From Stella</h2>
        <p style={styles.blockedMessage}>
          This game needs a Stella launch token before it can join or host
          multiplayer sessions.
        </p>
        {displayName ? (
          <div style={styles.signedInAs}>Signed in as {displayName}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  return <GameRouter />;
}

const styles: Record<string, React.CSSProperties> = {
  connecting: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    minHeight: "100vh",
    fontFamily: "system-ui, sans-serif",
    opacity: 0.6,
  },
  spinner: {
    width: 24,
    height: 24,
    border: "2px solid rgba(255,255,255,0.2)",
    borderTopColor: "rgba(255,255,255,0.8)",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  joinContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    fontFamily: "system-ui, sans-serif",
  },
  joinCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: 32,
    borderRadius: 16,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    minWidth: 320,
  },
  joinTitle: {
    fontSize: 20,
    fontWeight: 600,
    margin: "0 0 8px",
  },
  signedInAs: {
    fontSize: 14,
    opacity: 0.72,
    textAlign: "center",
  },
  helperText: {
    fontSize: 13,
    opacity: 0.6,
  },
  blockedMessage: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    textAlign: "center",
    opacity: 0.8,
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.05)",
    color: "inherit",
    fontSize: 15,
    outline: "none",
    boxSizing: "border-box",
  },
  divider: {
    width: "100%",
    height: 1,
    background: "rgba(255,255,255,0.08)",
    margin: "4px 0",
  },
  primaryButton: {
    width: "100%",
    padding: "10px 24px",
    borderRadius: 8,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryButton: {
    width: "100%",
    padding: "10px 24px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "transparent",
    color: "inherit",
    fontSize: 15,
    cursor: "pointer",
  },
  orText: {
    fontSize: 13,
    opacity: 0.4,
  },
  error: {
    fontSize: 13,
    color: "#f87171",
    textAlign: "center",
  },
};
