import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
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

const BOARD_CENTER = (BOARD_SIZE - 1) / 2;
const CELL_GAP = 0.08;

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

function pointToScene(point: Point) {
  return {
    x: point.x - BOARD_CENTER,
    z: point.y - BOARD_CENTER,
  };
}

type SnakeSceneProps = {
  snake: Point[];
  food: Point;
  status: GameStatus;
  onFocus: (node: HTMLDivElement | null) => void;
};

function SnakeScene({ snake, food, status, onFocus }: SnakeSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    snakeGroup: THREE.Group;
    foodMesh: THREE.Mesh;
    animationFrame: number;
    resizeObserver: ResizeObserver;
    startTime: number;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070915);
    scene.fog = new THREE.Fog(0x070915, 18, 34);
    const reusableMaterials: THREE.Material[] = [];
    const reusableGeometries: THREE.BufferGeometry[] = [];

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 15.5, 18);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xbfd7ff, 0x161827, 1.15);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-5, 12, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0x8a6cff, 32, 28);
    rimLight.position.set(7, 7, -7);
    scene.add(rimLight);

    const boardGroup = new THREE.Group();
    const tileGeometry = new THREE.BoxGeometry(1 - CELL_GAP, 0.12, 1 - CELL_GAP);
    const tileMaterial = new THREE.MeshStandardMaterial({
      color: 0x182238,
      roughness: 0.72,
      metalness: 0.1,
    });
    reusableGeometries.push(tileGeometry);
    reusableMaterials.push(tileMaterial);

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const tile = new THREE.Mesh(tileGeometry, tileMaterial);
        const scenePoint = pointToScene({ x, y });
        tile.position.set(scenePoint.x, -0.08, scenePoint.z);
        tile.receiveShadow = true;
        boardGroup.add(tile);
      }
    }
    scene.add(boardGroup);

    const borderGeometry = new THREE.BoxGeometry(BOARD_SIZE + 0.8, 0.5, 0.26);
    const borderMaterial = new THREE.MeshStandardMaterial({
      color: 0x26345a,
      emissive: 0x111836,
      roughness: 0.45,
    });
    reusableGeometries.push(borderGeometry);
    reusableMaterials.push(borderMaterial);
    const borderOffset = BOARD_CENTER + 0.7;
    const borders = [
      [0, borderOffset, 0],
      [0, -borderOffset, 0],
      [borderOffset, 0, Math.PI / 2],
      [-borderOffset, 0, Math.PI / 2],
    ] as const;
    borders.forEach(([x, z, rotation]) => {
      const border = new THREE.Mesh(borderGeometry, borderMaterial);
      border.position.set(x, 0.12, z);
      border.rotation.y = rotation;
      border.castShadow = true;
      border.receiveShadow = true;
      scene.add(border);
    });

    const snakeGroup = new THREE.Group();
    scene.add(snakeGroup);

    const foodGeometry = new THREE.IcosahedronGeometry(0.42, 2);
    const foodMaterial = new THREE.MeshStandardMaterial({
      color: 0xff426d,
      emissive: 0x7d1030,
      roughness: 0.28,
      metalness: 0.12,
    });
    reusableGeometries.push(foodGeometry);
    reusableMaterials.push(foodMaterial);
    const foodMesh = new THREE.Mesh(foodGeometry, foodMaterial);
    foodMesh.castShadow = true;
    scene.add(foodMesh);

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const startTime = performance.now();
    const animate = () => {
      const state = sceneRef.current;
      if (!state) return;
      const elapsed = (performance.now() - state.startTime) / 1000;
      state.foodMesh.rotation.y = elapsed * 1.8;
      state.foodMesh.position.y = 0.52 + Math.sin(elapsed * 4) * 0.08;
      state.scene.rotation.y = Math.sin(elapsed * 0.16) * 0.035;
      state.renderer.render(state.scene, state.camera);
      state.animationFrame = requestAnimationFrame(animate);
    };

    sceneRef.current = {
      renderer,
      scene,
      camera,
      snakeGroup,
      foodMesh,
      animationFrame: requestAnimationFrame(animate),
      resizeObserver,
      startTime,
    };

    return () => {
      const state = sceneRef.current;
      if (!state) return;
      cancelAnimationFrame(state.animationFrame);
      state.resizeObserver.disconnect();
      state.renderer.dispose();
      reusableGeometries.forEach((geometry) => geometry.dispose());
      reusableMaterials.forEach((material) => material.dispose());
      mount.removeChild(state.renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;

    state.snakeGroup.children.forEach((child) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    state.snakeGroup.clear();
    const bodyGeometry = new THREE.BoxGeometry(0.86, 0.78, 0.86);
    const headGeometry = new THREE.SphereGeometry(0.52, 24, 18);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: status === "game-over" ? 0x8d95a8 : 0x2adf71,
      emissive: status === "game-over" ? 0x20222a : 0x0d542b,
      roughness: 0.34,
      metalness: 0.08,
    });
    const headMaterial = new THREE.MeshStandardMaterial({
      color: status === "game-over" ? 0xd5d9e3 : 0xc7ff67,
      emissive: status === "game-over" ? 0x2d3038 : 0x3f741b,
      roughness: 0.25,
      metalness: 0.05,
    });

    snake.forEach((part, index) => {
      const scenePoint = pointToScene(part);
      const mesh = new THREE.Mesh(
        index === 0 ? headGeometry.clone() : bodyGeometry.clone(),
        index === 0 ? headMaterial.clone() : bodyMaterial.clone(),
      );
      mesh.position.set(scenePoint.x, index === 0 ? 0.58 : 0.42, scenePoint.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      state.snakeGroup.add(mesh);
    });

    const sceneFood = pointToScene(food);
    state.foodMesh.position.set(sceneFood.x, 0.52, sceneFood.z);

    bodyGeometry.dispose();
    headGeometry.dispose();
    bodyMaterial.dispose();
    headMaterial.dispose();
  }, [food, snake, status]);

  return (
    <div
      ref={(node) => {
        mountRef.current = node;
        onFocus(node);
      }}
      className="snake-board snake-board--three"
      tabIndex={0}
      role="application"
      aria-label="3D Snake board"
      data-stella-label="3D Snake board"
      data-stella-state={status}
    />
  );
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
            <SnakeScene snake={snake} food={food} status={status} onFocus={(node) => { boardRef.current = node; }} />
            <p className="snake-hint">Space pauses. Enter starts. Click the 3D board if keys are not steering.</p>
          </div>
        </section>
      </div>
    </div>
  );
}

export default SnakeApp;
