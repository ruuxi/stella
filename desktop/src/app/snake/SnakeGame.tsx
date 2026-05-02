import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import "./snake.css";

/**
 * Classic snake. Grid-based logic, canvas-rendered with sub-cell
 * interpolation so movement feels smooth instead of "tick-y". The game
 * model itself is a fixed-rate state machine driven by `tick()`; the render
 * loop draws the current state plus a [0..1] interpolation factor toward
 * the next tick.
 */

const GRID_W = 24;
const GRID_H = 24;
// Logical px per grid cell. The canvas itself is DPR-scaled below so the
// rendered pixels stay crisp on retina. We size the cell generously so the
// board fills a comfortable chunk of the workspace; the wrapping CSS caps
// it visually if the window is narrower.
const CELL = 32;
const BOARD_PX_W = GRID_W * CELL;
const BOARD_PX_H = GRID_H * CELL;

// Tick interval in ms. Slightly speeds up as the snake grows for some
// arcade-y progression, capped so it stays playable.
const BASE_TICK_MS = 120;
const MIN_TICK_MS = 60;
const SPEEDUP_PER_FOOD = 3;

const HIGH_SCORE_KEY = "stella.snake.highScore";

type Vec = { x: number; y: number };
type Dir = "up" | "down" | "left" | "right";

const DIR_VEC: Record<Dir, Vec> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

type Status = "idle" | "playing" | "gameover";

type GameState = {
  // Snake body in grid coordinates, head at index 0.
  snake: Vec[];
  dir: Dir;
  // Buffered direction inputs the user pressed before the next tick.
  // Lets quick "up then right" combos all register instead of one being
  // dropped because the tick hadn't fired yet.
  inputQueue: Dir[];
  food: Vec;
  score: number;
  status: Status;
};

const initialState = (): GameState => ({
  snake: [
    { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) },
    { x: Math.floor(GRID_W / 2) - 1, y: Math.floor(GRID_H / 2) },
    { x: Math.floor(GRID_W / 2) - 2, y: Math.floor(GRID_H / 2) },
  ],
  dir: "right",
  inputQueue: [],
  food: spawnFood([
    { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) },
    { x: Math.floor(GRID_W / 2) - 1, y: Math.floor(GRID_H / 2) },
    { x: Math.floor(GRID_W / 2) - 2, y: Math.floor(GRID_H / 2) },
  ]),
  score: 0,
  status: "idle",
});

function spawnFood(snake: Vec[]): Vec {
  // Build a set of occupied cells, then pick one of the free cells uniformly.
  // For a 24x24 board with a small snake this is essentially free.
  const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
  const free: Vec[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return { x: 0, y: 0 };
  return free[Math.floor(Math.random() * free.length)]!;
}

function readHighScore(): number {
  try {
    const raw = window.localStorage?.getItem(HIGH_SCORE_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeHighScore(n: number): void {
  try {
    window.localStorage?.setItem(HIGH_SCORE_KEY, String(n));
  } catch {
    // ignore
  }
}

export function SnakeGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Game state lives in a ref so the rAF loop and key handlers don't trigger
  // React re-renders on every tick — only score/status pushes state down.
  // We initialize the ref *once* on the first render via the official
  // "lazy ref init" pattern from the React docs:
  //   https://react.dev/reference/react/useRef#avoiding-recreating-the-ref-contents
  // The `react-hooks/refs` rule flags ref access during render in general, but
  // this exact pattern is the documented exception.
  /* eslint-disable react-hooks/refs */
  const stateRef = useRef<GameState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = initialState();
  }
  // Previous-tick snake positions, used to interpolate cell movement for
  // smooth rendering between ticks. Same lazy-init pattern.
  const prevSnakeRef = useRef<Vec[] | null>(null);
  if (prevSnakeRef.current === null) {
    prevSnakeRef.current = stateRef.current.snake.map((p) => ({ ...p }));
  }
  /* eslint-enable react-hooks/refs */

  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [highScore, setHighScore] = useState<number>(() => readHighScore());

  const tickIntervalForScore = useCallback((s: number) => {
    return Math.max(MIN_TICK_MS, BASE_TICK_MS - s * SPEEDUP_PER_FOOD);
  }, []);

  const enqueueDirection = useCallback((next: Dir) => {
    const st = stateRef.current!;
    if (st.status === "gameover") return;

    // Reject inputs that would reverse the snake into itself. We compare
    // against the *last queued* direction (or current dir if queue empty)
    // so that holding two opposite arrows in quick succession can't slip
    // a 180° turn through.
    const prev = st.inputQueue.length > 0 ? st.inputQueue[st.inputQueue.length - 1]! : st.dir;
    if (next === prev || next === OPPOSITE[prev]) return;

    // Cap the queue so a key-spammer can't build up a huge backlog.
    if (st.inputQueue.length >= 3) return;
    st.inputQueue.push(next);
  }, []);

  const startGame = useCallback(() => {
    const fresh = initialState();
    fresh.status = "playing";
    stateRef.current = fresh;
    prevSnakeRef.current = fresh.snake.map((p) => ({ ...p }));
    setScore(0);
    setStatus("playing");
  }, []);

  const restart = useCallback(() => {
    startGame();
  }, [startGame]);

  // Apply one game tick. Returns whether the snake just ate so the render
  // loop can choose a tail-stretch animation if it ever needs one.
  const tick = useCallback(() => {
    const st = stateRef.current!;
    if (st.status !== "playing") return;

    // Snapshot pre-move positions for interpolation.
    prevSnakeRef.current = st.snake.map((p) => ({ ...p }));

    // Pull the next buffered direction (if any) and commit it.
    if (st.inputQueue.length > 0) {
      const next = st.inputQueue.shift()!;
      if (next !== OPPOSITE[st.dir]) {
        st.dir = next;
      }
    }

    const head = st.snake[0]!;
    const v = DIR_VEC[st.dir];
    const newHead: Vec = { x: head.x + v.x, y: head.y + v.y };

    // Wall collision.
    if (
      newHead.x < 0 ||
      newHead.x >= GRID_W ||
      newHead.y < 0 ||
      newHead.y >= GRID_H
    ) {
      st.status = "gameover";
      setStatus("gameover");
      setHighScore((prev) => {
        if (st.score > prev) {
          writeHighScore(st.score);
          return st.score;
        }
        return prev;
      });
      return;
    }

    // Self-collision. We compare against the body *minus the tail* because
    // the tail will move out of its current cell on the same tick — unless
    // we're growing this tick.
    const willEat = newHead.x === st.food.x && newHead.y === st.food.y;
    const bodyToCheck = willEat ? st.snake : st.snake.slice(0, -1);
    for (const seg of bodyToCheck) {
      if (seg.x === newHead.x && seg.y === newHead.y) {
        st.status = "gameover";
        setStatus("gameover");
        setHighScore((prev) => {
          if (st.score > prev) {
            writeHighScore(st.score);
            return st.score;
          }
          return prev;
        });
        return;
      }
    }

    // Move: prepend new head, conditionally pop tail.
    st.snake.unshift(newHead);
    if (willEat) {
      st.score += 1;
      setScore(st.score);
      st.food = spawnFood(st.snake);
    } else {
      st.snake.pop();
    }
  }, []);

  // Render loop: rAF-driven, drives the tick at a fixed cadence and draws
  // an interpolated frame using `prevSnake` and `snake`.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set up DPR scaling once. The canvas's CSS size is BOARD_PX_W x BOARD_PX_H.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = BOARD_PX_W * dpr;
    canvas.height = BOARD_PX_H * dpr;
    canvas.style.width = `${BOARD_PX_W}px`;
    canvas.style.height = `${BOARD_PX_H}px`;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let lastTickAt = performance.now();

    const computeStyles = (): {
      grid: string;
      gridStrong: string;
      snakeHead: string;
      snakeBody: string;
      food: string;
      foodGlow: string;
    } => {
      // Read CSS custom properties off the document root so the game tracks
      // the active Stella theme.
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue("--accent").trim() || "#ee5396";
      const fg = css.getPropertyValue("--foreground").trim() || "#161616";
      // Fall back to color-mix for grid lines so they read on both themes.
      const grid = `color-mix(in srgb, ${fg} 8%, transparent)`;
      const gridStrong = `color-mix(in srgb, ${fg} 14%, transparent)`;
      const snakeBody = fg;
      const snakeHead = `color-mix(in srgb, ${fg} 90%, ${accent} 10%)`;
      const food = accent;
      const foodGlow = `color-mix(in srgb, ${accent} 50%, transparent)`;
      return { grid, gridStrong, snakeHead, snakeBody, food, foodGlow };
    };

    const drawGrid = (styles: ReturnType<typeof computeStyles>) => {
      ctx.clearRect(0, 0, BOARD_PX_W, BOARD_PX_H);
      // Soft grid lines.
      ctx.lineWidth = 1;
      ctx.strokeStyle = styles.grid;
      for (let x = 1; x < GRID_W; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL + 0.5, 0);
        ctx.lineTo(x * CELL + 0.5, BOARD_PX_H);
        ctx.stroke();
      }
      for (let y = 1; y < GRID_H; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL + 0.5);
        ctx.lineTo(BOARD_PX_W, y * CELL + 0.5);
        ctx.stroke();
      }
    };

    const drawCell = (
      x: number,
      y: number,
      color: string,
      radius = 5,
      inset = 1,
    ) => {
      const px = x * CELL + inset;
      const py = y * CELL + inset;
      const w = CELL - inset * 2;
      const h = CELL - inset * 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      // Rounded square.
      const r = Math.min(radius, w / 2, h / 2);
      ctx.moveTo(px + r, py);
      ctx.lineTo(px + w - r, py);
      ctx.quadraticCurveTo(px + w, py, px + w, py + r);
      ctx.lineTo(px + w, py + h - r);
      ctx.quadraticCurveTo(px + w, py + h, px + w - r, py + h);
      ctx.lineTo(px + r, py + h);
      ctx.quadraticCurveTo(px, py + h, px, py + h - r);
      ctx.lineTo(px, py + r);
      ctx.quadraticCurveTo(px, py, px + r, py);
      ctx.closePath();
      ctx.fill();
    };

    const drawCellPx = (
      px: number,
      py: number,
      color: string,
      radius = 5,
      inset = 1,
    ) => {
      const x = px + inset;
      const y = py + inset;
      const w = CELL - inset * 2;
      const h = CELL - inset * 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      const r = Math.min(radius, w / 2, h / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
    };

    const draw = (alpha: number) => {
      const st = stateRef.current!;
      const styles = computeStyles();

      drawGrid(styles);

      // Food: soft glow + cell.
      const fx = st.food.x * CELL + CELL / 2;
      const fy = st.food.y * CELL + CELL / 2;
      const glow = ctx.createRadialGradient(fx, fy, 1, fx, fy, CELL);
      glow.addColorStop(0, styles.foodGlow);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(
        st.food.x * CELL - CELL / 2,
        st.food.y * CELL - CELL / 2,
        CELL * 2,
        CELL * 2,
      );
      drawCell(st.food.x, st.food.y, styles.food, 9, 5);

      // Snake: interpolate each segment from its previous tick position to
      // its current one. While idle / gameover we just render at alpha=1
      // so the body sits flush in its grid cell.
      const useInterp = st.status === "playing";
      const a = useInterp ? Math.max(0, Math.min(1, alpha)) : 1;
      const prev = prevSnakeRef.current!;

      for (let i = st.snake.length - 1; i >= 0; i--) {
        const cur = st.snake[i]!;
        // Tail trick: when the snake didn't grow this tick, its segment[i]
        // is the *previous* segment[i-1]. We approximate by lerping cur
        // toward prev[i] (or last entry).
        const p = prev[i] ?? prev[prev.length - 1] ?? cur;
        const ix = p.x + (cur.x - p.x) * a;
        const iy = p.y + (cur.y - p.y) * a;
        const px = ix * CELL;
        const py = iy * CELL;
        const isHead = i === 0;
        drawCellPx(
          px,
          py,
          isHead ? styles.snakeHead : styles.snakeBody,
          isHead ? 11 : 8,
          isHead ? 2 : 3,
        );
      }
    };

    const loop = (now: number) => {
      const st = stateRef.current!;
      const interval = tickIntervalForScore(st.score);
      // Run as many ticks as needed if the tab was throttled, but cap to
      // avoid death-spirals after long backgrounding.
      let safety = 5;
      while (st.status === "playing" && now - lastTickAt >= interval && safety-- > 0) {
        tick();
        lastTickAt += interval;
      }
      const alpha = st.status === "playing" ? (now - lastTickAt) / interval : 1;
      draw(alpha);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tick, tickIntervalForScore]);

  // Keyboard input. We listen on window so the canvas doesn't need focus,
  // but we ignore events when the user is typing in any text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      // Space / Enter: start or restart.
      if (e.key === " " || e.key === "Enter") {
        const st = stateRef.current!;
        if (st.status !== "playing") {
          e.preventDefault();
          startGame();
        }
        return;
      }

      let dir: Dir | null = null;
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          dir = "up";
          break;
        case "ArrowDown":
        case "s":
        case "S":
          dir = "down";
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          dir = "left";
          break;
        case "ArrowRight":
        case "d":
        case "D":
          dir = "right";
          break;
      }
      if (dir) {
        e.preventDefault();
        // First arrow press from idle also starts the game.
        const st = stateRef.current!;
        if (st.status === "idle") {
          startGame();
        }
        enqueueDirection(dir);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enqueueDirection, startGame]);

  const overlay = useMemo(() => {
    if (status === "playing") return null;
    if (status === "idle") {
      return (
        <div className="snake-overlay" data-stella-state="snake-idle">
          <div className="snake-overlay-card">
            <div className="snake-overlay-eyebrow">Snake</div>
            <p className="snake-overlay-title">Ready to play</p>
            <p className="snake-overlay-sub">
              Press <kbd>Space</kbd> or any arrow key to start.
            </p>
            <Button
              variant="primary"
              size="normal"
              onClick={startGame}
              data-stella-action="snake-start"
              data-stella-label="Start"
            >
              Start
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="snake-overlay" data-stella-state="snake-gameover">
        <div className="snake-overlay-card">
          <div className="snake-overlay-eyebrow">Game over</div>
          <p className="snake-overlay-title">Score {score}</p>
          <p className="snake-overlay-sub">Best {highScore}</p>
          <Button
            variant="primary"
            size="normal"
            onClick={restart}
            data-stella-action="snake-restart"
            data-stella-label="Play again"
          >
            Play again
          </Button>
        </div>
      </div>
    );
  }, [status, score, highScore, startGame, restart]);

  return (
    <div
      className="snake-app"
      data-stella-label="Snake"
      data-stella-state={status}
    >
      <header className="snake-header">
        <h1 className="snake-title">
          <span className="snake-title-dot" aria-hidden />
          Snake
        </h1>
        <div className="snake-scores" aria-live="polite">
          <span className="snake-score-pill" data-stella-label="Snake score">
            Score <strong>{score}</strong>
          </span>
          <span className="snake-score-pill" data-stella-label="Snake best">
            Best <strong>{highScore}</strong>
          </span>
        </div>
      </header>

      <div className="snake-board-wrap">
        <canvas
          ref={canvasRef}
          className="snake-canvas"
          width={BOARD_PX_W}
          height={BOARD_PX_H}
          aria-label="Snake game board"
          role="img"
        />
        {overlay}
      </div>

      <div className="snake-controls">
        <span className="snake-hint">
          Steer with <kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> or <kbd>W</kbd>
          <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
        </span>
        <div className="snake-actions">
          <Button
            variant="secondary"
            size="normal"
            onClick={restart}
            data-stella-action="snake-restart"
            data-stella-label="Restart"
          >
            Restart
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SnakeGame;
