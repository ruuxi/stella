/**
 * Game lobby — waiting room before the game starts.
 * Shows the join code, player list, and a start button for the host.
 */

import { useTable } from "spacetimedb/react";
import { tables } from "../bindings";

type LobbyProps = {
  sessionId: bigint;
  joinCode: string;
  isHost: boolean;
  onStartGame: () => void;
};

export function Lobby({ sessionId, joinCode, isHost, onStartGame }: LobbyProps) {
  const [players, playersReady] = useTable(tables.gamePlayers);
  const sessionPlayers = players.filter(
    (p) => p.sessionId === sessionId,
  );

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.codeLabel}>Join Code</div>
        <div style={styles.code}>{joinCode}</div>
        <button
          style={styles.copyButton}
          onClick={() => {
            void navigator.clipboard.writeText(joinCode);
          }}
        >
          Copy Code
        </button>
      </div>

      <div style={styles.playerList}>
        <div style={styles.sectionLabel}>
          Players ({sessionPlayers.length})
        </div>
        {!playersReady && <div style={styles.loading}>Connecting...</div>}
        {sessionPlayers.map((player) => (
          <div key={String(player.id)} style={styles.playerRow}>
            <span style={styles.playerName}>{player.displayName}</span>
            {player.isHost === 1 && <span style={styles.hostBadge}>Host</span>}
            <span
              style={{
                ...styles.statusDot,
                backgroundColor:
                  player.status === "connected" ? "#4ade80" : "#94a3b8",
              }}
            />
          </div>
        ))}
      </div>

      {isHost && (
        <button
          style={{
            ...styles.startButton,
            opacity: sessionPlayers.length < 2 ? 0.5 : 1,
          }}
          disabled={sessionPlayers.length < 2}
          onClick={onStartGame}
        >
          Start Game
        </button>
      )}

      {!isHost && (
        <div style={styles.waitingText}>Waiting for the host to start...</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 24,
    padding: 32,
    fontFamily: "system-ui, sans-serif",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: 24,
    borderRadius: 12,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  codeLabel: {
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    opacity: 0.6,
  },
  code: {
    fontSize: 48,
    fontWeight: 700,
    letterSpacing: "0.15em",
    fontFamily: "monospace",
  },
  copyButton: {
    padding: "6px 16px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 13,
  },
  playerList: {
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    opacity: 0.5,
    marginBottom: 4,
  },
  loading: {
    opacity: 0.5,
    fontSize: 14,
  },
  playerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.03)",
  },
  playerName: {
    flex: 1,
    fontSize: 15,
  },
  hostBadge: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.1)",
    opacity: 0.7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  startButton: {
    padding: "12px 32px",
    borderRadius: 10,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  waitingText: {
    opacity: 0.5,
    fontSize: 14,
  },
};
