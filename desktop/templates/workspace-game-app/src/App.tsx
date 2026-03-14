/**
 * Game app root — routes between lobby and active game.
 *
 * Reads session info from URL parameters for the join flow.
 * Manages the connection to SpacetimeDB and the game lifecycle.
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { tables, reducers } from "./bindings";
import { Lobby } from "./components/Lobby";
import { GameView } from "./components/GameView";
import {
  clearHostedLaunchAuth,
  getJoinCodeFromUrl,
  getLaunchDisplayName,
  getLaunchGameToken,
  getSessionFromUrl,
  isHostedGameAuthMessage,
  saveHostedLaunchAuth,
} from "./lib/session";

type LaunchAuthState =
  | { status: "waiting"; displayName?: string }
  | { status: "ready"; gameToken: string; displayName?: string }
  | { status: "blocked"; displayName?: string };

function useHostedLaunchAuth(): LaunchAuthState {
  const [state, setState] = useState<LaunchAuthState>(() => {
    const gameToken = getLaunchGameToken();
    const displayName = getLaunchDisplayName();
    if (gameToken) {
      return { status: "ready", gameToken, ...(displayName ? { displayName } : {}) };
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
          ...(getLaunchDisplayName() ? { displayName: getLaunchDisplayName()! } : {}),
        });
        return;
      }
      if (window.parent === window) {
        clearHostedLaunchAuth();
        setState({
          status: "blocked",
          ...(getLaunchDisplayName() ? { displayName: getLaunchDisplayName()! } : {}),
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
  const [sessions] = useTable(tables.game_sessions);
  const [players] = useTable(tables.game_players);

  const startGame = useReducer(reducers.startGame);

  // Find the active session (from URL param or first available)
  const urlSession = getSessionFromUrl();
  const session = urlSession
    ? sessions.find((s) => String(s.sessionId) === urlSession)
    : sessions[0] ?? null;

  // Find our player in the session
  const myPlayer =
    session && identity
      ? players.find(
          (p) =>
            p.sessionId === session.sessionId &&
            p.playerIdentity.isEqual(identity),
        )
      : null;

  const isHost = myPlayer?.isHost === 1;

  const handleStartGame = useCallback(() => {
    if (!session) return;
    void startGame({ sessionId: session.sessionId });
  }, [session, startGame]);

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

  if (!session) {
    return <JoinOrCreate launchAuth={launchAuth} />;
  }

  if (session.status === "lobby") {
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
      playerSlot={myPlayer?.slot ?? 0}
      isHost={isHost}
    />
  );
}

/**
 * Join or create screen — shown when no session is active.
 */
function JoinOrCreate({ launchAuth }: { launchAuth: Extract<LaunchAuthState, { status: "ready" }> }) {
  const [joinCode, setJoinCode] = useState(getJoinCodeFromUrl() ?? "");
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
  }, [launchAuth, registerPlayer]);

  const handleJoin = useCallback(async () => {
    if (!joinCode.trim()) return;
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
        configJson: "{}",
        maxPlayers: 8,
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
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          maxLength={4}
          style={{ ...styles.input, textAlign: "center", letterSpacing: "0.2em", fontSize: 20 }}
        />
        <button
          onClick={handleJoin}
          disabled={!joinCode.trim()}
          style={styles.primaryButton}
        >
          Join Game
        </button>

        <div style={styles.orText}>or</div>

        <button
          onClick={handleCreate}
          style={styles.secondaryButton}
        >
          Create New Game
        </button>

        {error && <div style={styles.error}>{error}</div>}
      </div>
    </div>
  );
}

function WaitingForStella({ displayName }: { displayName?: string }) {
  return (
    <div style={styles.connecting}>
      <div style={styles.spinner} />
      <span>Waiting for Stella to authorize this game...</span>
      {displayName ? <span style={styles.helperText}>Signed in as {displayName}</span> : null}
    </div>
  );
}

function LaunchBlocked({ displayName }: { displayName?: string }) {
  return (
    <div style={styles.joinContainer}>
      <div style={styles.joinCard}>
        <h2 style={styles.joinTitle}>Open From Stella</h2>
        <p style={styles.blockedMessage}>
          This game needs a Stella launch token before it can join or host multiplayer sessions.
        </p>
        {displayName ? <div style={styles.signedInAs}>Signed in as {displayName}</div> : null}
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
    textAlign: "center" as const,
  },
  helperText: {
    fontSize: 13,
    opacity: 0.6,
  },
  blockedMessage: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    textAlign: "center" as const,
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
    boxSizing: "border-box" as const,
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
    textAlign: "center" as const,
  },
};
