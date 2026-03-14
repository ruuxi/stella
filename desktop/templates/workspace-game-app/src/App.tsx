/**
 * Game app root — routes between lobby and active game.
 *
 * Reads session info from URL parameters for the join flow.
 * Manages the connection to SpacetimeDB and the game lifecycle.
 */

import { useState, useCallback } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { tables, reducers } from "./bindings";
import { Lobby } from "./components/Lobby";
import { GameView } from "./components/GameView";
import {
  bootstrapLaunchStateFromUrl,
  getJoinCodeFromUrl,
  getLaunchConvexToken,
  getLaunchDisplayName,
  getSessionFromUrl,
  saveLaunchDisplayName,
} from "./lib/session";

bootstrapLaunchStateFromUrl();

function GameRouter() {
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

  if (!isActive) {
    return (
      <div style={styles.connecting}>
        <div style={styles.spinner} />
        <span>Connecting...</span>
      </div>
    );
  }

  if (!session) {
    return <JoinOrCreate />;
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
function JoinOrCreate() {
  const [joinCode, setJoinCode] = useState(getJoinCodeFromUrl() ?? "");
  const [name, setName] = useState(getLaunchDisplayName() ?? "");
  const [error, setError] = useState<string | null>(null);

  const registerPlayer = useReducer(reducers.registerPlayer);
  const joinSession = useReducer(reducers.joinSession);
  const createSession = useReducer(reducers.createSession);

  const ensureRegistered = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("Enter your name to continue.");
    }

    const convexToken = getLaunchConvexToken();
    if (!convexToken) {
      throw new Error("Open this game from Stella to join or host a session.");
    }

    saveLaunchDisplayName(trimmedName);
    await registerPlayer({
      convexToken,
      displayName: trimmedName,
    });
  }, [name, registerPlayer]);

  const handleJoin = useCallback(async () => {
    if (!joinCode.trim() || !name.trim()) return;
    setError(null);
    try {
      await ensureRegistered();
      await joinSession({
        joinCode: joinCode.trim().toUpperCase(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join");
    }
  }, [ensureRegistered, joinCode, name, joinSession]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
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
  }, [createSession, ensureRegistered, name]);

  return (
    <div style={styles.joinContainer}>
      <div style={styles.joinCard}>
        <h2 style={styles.joinTitle}>{{name}}</h2>

        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={styles.input}
        />

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
          disabled={!joinCode.trim() || !name.trim()}
          style={styles.primaryButton}
        >
          Join Game
        </button>

        <div style={styles.orText}>or</div>

        <button
          onClick={handleCreate}
          disabled={!name.trim()}
          style={styles.secondaryButton}
        >
          Create New Game
        </button>

        {error && <div style={styles.error}>{error}</div>}
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
