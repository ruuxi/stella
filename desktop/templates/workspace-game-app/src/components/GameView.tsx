/**
 * GameView — the main game area.
 *
 * This is a PLACEHOLDER. The Stella agent replaces this component
 * with game-specific UI (trivia questions, card layouts, drawing
 * canvas, scoreboard, etc.) during game creation.
 */

type GameViewProps = {
  sessionId: bigint;
  playerSlot: number;
  isHost: boolean;
};

export function GameView({ sessionId, playerSlot, isHost }: GameViewProps) {
  return (
    <div style={styles.container}>
      <div style={styles.placeholder}>
        <div style={styles.title}>Game Active</div>
        <div style={styles.info}>
          Session: {String(sessionId)} | Slot: {playerSlot}
          {isHost ? " (Host)" : ""}
        </div>
        <div style={styles.hint}>
          This placeholder will be replaced with your game's UI.
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    fontFamily: "system-ui, sans-serif",
  },
  placeholder: {
    textAlign: "center" as const,
    padding: 48,
    borderRadius: 16,
    background: "rgba(255,255,255,0.03)",
    border: "1px dashed rgba(255,255,255,0.15)",
  },
  title: {
    fontSize: 24,
    fontWeight: 600,
    marginBottom: 8,
  },
  info: {
    fontSize: 14,
    opacity: 0.6,
    fontFamily: "monospace",
    marginBottom: 16,
  },
  hint: {
    fontSize: 13,
    opacity: 0.4,
  },
};
