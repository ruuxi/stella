import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import "./snake.css";

const BOARD_SIZE = 18;
const TICK_MS = 120;

type Direction = "up" | "down" | "left" | "right";
type Point = { x: number; y: number };
type GameStatus = "ready" | "playing" | "paused" | "game-over";

const START_SNAKE: Point[] = [
  { x: 8, y: 9 },
  { x: 7, y: 9 },
  { x: 6, y: 9 },
];

const START_FOOD: Point = { x: 12, y: 9 };

const directionDelta: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const oppositeDirection: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function randomFood(snake: Point[]): Point {
  const occupied = new Set(snake.map((part) => `${part.x}:${part.y}`));
  const available: Point[] = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (!occupied.has(`${x}:${y}`)) available.push({ x, y });
    }
  }

  return available[Math.floor(Math.random() * available.length)] ?? START_FOOD;
}

function getHighScore() {
  const stored = window.localStorage.getItem("stella:snake:highScore");
  return stored ? Number(stored) || 0 : 0;
}

export function SnakeApp() {
  const [snake, setSnake] = useState<Point[]>(START_SNAKE);
  const [food, setFood] = useState<Point>(START_FOOD);
  const [direction, setDirection] = useState<Direction>("right");
  const [nextDirection, setNextDirection] = useState<Direction>("right");
  const [status, setStatus] = useState<GameStatus>("ready");
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(getHighScore);

  const boardRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  const nextDirectionRef = useRef(nextDirection);
  const directionRef = useRef(direction);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    nextDirectionRef.current = nextDirection;
  }, [nextDirection]);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

  const startGame = useCallback(() => {
    setSnake(START_SNAKE);
    setFood(randomFood(START_SNAKE));
    setDirection("right");
    setNextDirection("right");
    setScore(0);
    setStatus("playing");
    requestAnimationFrame(() => boardRef.current?.focus());
  }, []);

  const setBufferedDirection = useCallback((newDirection: Direction) => {
    if (oppositeDirection[directionRef.current] === newDirection) return;
    setNextDirection(newDirection);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyDirection: Record<string, Direction | undefined> = {
        ArrowUp: "up",
        w: "up",
        W: "up",
        ArrowDown: "down",
        s: "down",
        S: "down",
        ArrowLeft: "left",
        a: "left",
        A: "left",
        ArrowRight: "right",
        d: "right",
        D: "right",
      };

      const newDirection = keyDirection[event.key];
      if (newDirection) {
        event.preventDefault();
        if (statusRef.current === "ready" || statusRef.current === "game-over") {
          startGame();
        }
        setBufferedDirection(newDirection);
        return;
      }

      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setStatus((current) => {
          if (current === "playing") return "paused";
          if (current === "paused") return "playing";
          startGame();
          return "playing";
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setBufferedDirection, startGame]);

  useEffect(() => {
    if (status !== "playing") return;

    const interval = window.setInterval(() => {
      setSnake((currentSnake) => {
        const currentDirection = nextDirectionRef.current;
        const delta = directionDelta[currentDirection];
        const head = currentSnake[0];
        const nextHead = { x: head.x + delta.x, y: head.y + delta.y };
        const ateFood = samePoint(nextHead, food);
        const bodyToCheck = ateFood ? currentSnake : currentSnake.slice(0, -1);
        const hitWall =
          nextHead.x < 0 ||
          nextHead.x >= BOARD_SIZE ||
          nextHead.y < 0 ||
          nextHead.y >= BOARD_SIZE;
        const hitSelf = bodyToCheck.some((part) => samePoint(part, nextHead));

        setDirection(currentDirection);

        if (hitWall || hitSelf) {
          setStatus("game-over");
          return currentSnake;
        }

        const nextSnake = [nextHead, ...currentSnake];
        if (!ateFood) nextSnake.pop();

        if (ateFood) {
          setScore((currentScore) => {
            const nextScore = currentScore + 1;
            setHighScore((currentHighScore) => {
              const nextHighScore = Math.max(currentHighScore, nextScore);
              window.localStorage.setItem(
                "stella:snake:highScore",
                String(nextHighScore),
              );
              return nextHighScore;
            });
            return nextScore;
          });
          setFood(randomFood(nextSnake));
        }

        return nextSnake;
      });
    }, TICK_MS);

    return () => window.clearInterval(interval);
  }, [food, status]);

  const cells = useMemo(() => {
    const snakeCells = new Map(snake.map((part, index) => [`${part.x}:${part.y}`, index]));

    return Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
      const x = index % BOARD_SIZE;
      const y = Math.floor(index / BOARD_SIZE);
      const snakeIndex = snakeCells.get(`${x}:${y}`);
      const isFood = samePoint(food, { x, y });

      return {
        key: `${x}:${y}`,
        isHead: snakeIndex === 0,
        isSnake: snakeIndex !== undefined,
        isFood,
      };
    });
  }, [food, snake]);

  return (
    <div className="workspace-area snake-app" data-stella-label="Snake app">
      <div className="workspace-content workspace-content--full snake-shell">
        <section className="snake-hero" data-stella-label="Snake game">
          <div className="snake-panel snake-panel--intro">
            <p className="snake-eyebrow">Arcade</p>
            <h1>Snake</h1>
            <p className="snake-copy">
              Eat the glowing apples, avoid the walls, and do not run into
              yourself. Use arrow keys or WASD to steer.
            </p>
            <div className="snake-actions">
              <Button
                variant="primary"
                onClick={startGame}
                data-stella-label="Start Snake game"
                data-stella-action="start-snake-game"
              >
                {status === "game-over" ? "Play again" : "Start game"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setStatus((current) => current === "playing" ? "paused" : "playing")}
                disabled={status === "ready" || status === "game-over"}
                data-stella-label="Pause Snake game"
                data-stella-action="toggle-snake-pause"
              >
                {status === "paused" ? "Resume" : "Pause"}
              </Button>
            </div>
          </div>

          <div className="snake-panel snake-game-card">
            <div className="snake-scorebar" data-stella-state={status}>
              <span>Status: {status.replace("-", " ")}</span>
              <span>Score: {score}</span>
              <span>Best: {highScore}</span>
            </div>
            <div
              ref={boardRef}
              className="snake-board"
              tabIndex={0}
              role="application"
              aria-label="Snake board"
              data-stella-label="Snake board"
              data-stella-state={status}
            >
              {cells.map((cell) => (
                <span
                  key={cell.key}
                  className="snake-cell"
                  data-snake={cell.isHead ? "head" : cell.isSnake ? "body" : cell.isFood ? "food" : "empty"}
                />
              ))}
            </div>
            <p className="snake-hint">Space pauses. Enter starts. Click the board if keys are not steering.</p>
          </div>
        </section>
      </div>
    </div>
  );
}

export default SnakeApp;
