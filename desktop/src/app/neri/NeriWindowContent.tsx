import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { NeriWindowType, NeriWindow } from "./neri-types";

// ─── News Feed ──────────────────────────────────────────────────────────

const NEWS_ITEMS = [
  { headline: "Breakthrough in Quantum Computing Achieves 1000-Qubit Milestone", source: "TechDaily", time: "2m ago", category: "Tech" },
  { headline: "Global Climate Summit Reaches Historic Agreement on Carbon Targets", source: "WorldNews", time: "15m ago", category: "World" },
  { headline: "AI-Powered Drug Discovery Enters Phase 3 Clinical Trials", source: "ScienceHub", time: "32m ago", category: "Science" },
  { headline: "Major Space Agency Announces Mars Colony Timeline for 2035", source: "SpaceWatch", time: "1h ago", category: "Space" },
  { headline: "New Renewable Energy Grid Powers Entire Country for First Time", source: "GreenTech", time: "2h ago", category: "Energy" },
  { headline: "Revolutionary Brain-Computer Interface Restores Full Mobility", source: "MedTech", time: "3h ago", category: "Health" },
  { headline: "Open Source AI Model Surpasses Commercial Alternatives", source: "DevWeekly", time: "4h ago", category: "Tech" },
  { headline: "Deep Sea Exploration Discovers New Ecosystem at Record Depth", source: "OceanSci", time: "5h ago", category: "Science" },
];

function NewsFeed() {
  return (
    <div className="neri-content-news">
      <div className="neri-news-tabs">
        <span className="neri-news-tab active">For You</span>
        <span className="neri-news-tab">World</span>
        <span className="neri-news-tab">Tech</span>
        <span className="neri-news-tab">Science</span>
      </div>
      <div className="neri-news-list">
        {NEWS_ITEMS.map((item, i) => (
          <div key={i} className="neri-news-item">
            <div className="neri-news-thumb" style={{ background: `hsl(${i * 40 + 200}, 40%, 25%)` }}>
              <span className="neri-news-category">{item.category}</span>
            </div>
            <div className="neri-news-text">
              <div className="neri-news-headline">{item.headline}</div>
              <div className="neri-news-meta">{item.source} · {item.time}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Music Player ───────────────────────────────────────────────────────

function MusicPlayer() {
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(42);

  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => setProgress((p) => (p >= 100 ? 0 : p + 0.5)), 200);
    return () => clearInterval(iv);
  }, [playing]);

  return (
    <div className="neri-content-music">
      <div className="neri-music-art" style={{ background: "linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)" }}>
        <div className="neri-music-vinyl" data-playing={playing}>
          <div className="neri-music-vinyl-inner" />
        </div>
      </div>
      <div className="neri-music-info">
        <div className="neri-music-title">Ethereal Horizons</div>
        <div className="neri-music-artist">Stellar Drift</div>
      </div>
      <div className="neri-music-progress">
        <div className="neri-music-progress-bar">
          <div className="neri-music-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="neri-music-times">
          <span>{Math.floor(progress * 2.4 / 60)}:{String(Math.floor(progress * 2.4) % 60).padStart(2, "0")}</span>
          <span>4:00</span>
        </div>
      </div>
      <div className="neri-music-controls">
        <button className="neri-music-btn">⏮</button>
        <button className="neri-music-btn primary" onClick={() => setPlaying(!playing)}>
          {playing ? "⏸" : "▶"}
        </button>
        <button className="neri-music-btn">⏭</button>
      </div>
      <div className="neri-music-queue">
        <div className="neri-music-queue-title">Up Next</div>
        {["Cosmic Waves — Nebula Sound", "Deep Space — Astral Echoes", "Gravity Well — Dark Matter"].map((t, i) => (
          <div key={i} className="neri-music-queue-item">{t}</div>
        ))}
      </div>
    </div>
  );
}

// ─── AI Search ──────────────────────────────────────────────────────────

function AISearch() {
  const [query, setQuery] = useState("How does quantum entanglement work?");
  const [searched, setSearched] = useState(true);

  return (
    <div className="neri-content-search">
      <div className="neri-search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setSearched(true); }}
          placeholder="Ask anything..."
        />
        <button onClick={() => setSearched(true)}>Search</button>
      </div>
      {searched && (
        <div className="neri-search-results">
          <div className="neri-search-ai-answer">
            <div className="neri-search-ai-label">AI Summary</div>
            <p>
              Quantum entanglement is a phenomenon where two or more particles become
              interconnected in such a way that the quantum state of each particle cannot
              be described independently. When particles are entangled, measuring one
              particle instantly influences the state of the other, regardless of the
              distance between them.
            </p>
            <p>
              This "spooky action at a distance" (as Einstein called it) has been
              experimentally verified and forms the basis for quantum computing,
              quantum cryptography, and quantum teleportation protocols.
            </p>
          </div>
          <div className="neri-search-sources">
            <div className="neri-search-source-label">Sources</div>
            {["Nature Physics — Quantum Entanglement Explained", "arxiv.org — Bell's Theorem and Beyond", "MIT OpenCourseWare — Quantum Mechanics"].map((s, i) => (
              <div key={i} className="neri-search-source">{s}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Calendar ───────────────────────────────────────────────────────────

function Calendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const monthName = today.toLocaleString("default", { month: "long" });

  const events: Record<number, string[]> = {
    [today.getDate()]: ["Team standup 10:00", "Design review 14:00"],
    [today.getDate() + 1]: ["Client call 11:00"],
    [today.getDate() + 3]: ["Sprint planning 9:00", "Lunch 12:30"],
    [today.getDate() + 5]: ["Release day"],
  };

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  return (
    <div className="neri-content-calendar">
      <div className="neri-cal-header">
        <span className="neri-cal-month">{monthName} {year}</span>
        <div className="neri-cal-nav">
          <button>←</button>
          <button>Today</button>
          <button>→</button>
        </div>
      </div>
      <div className="neri-cal-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="neri-cal-grid">
        {days.map((day, i) => (
          <div
            key={i}
            className={`neri-cal-day ${day === today.getDate() ? "today" : ""} ${day && events[day] ? "has-events" : ""}`}
          >
            {day && (
              <>
                <span className="neri-cal-day-num">{day}</span>
                {events[day]?.map((e, j) => (
                  <div key={j} className="neri-cal-event">{e}</div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Game (Asteroid Field) ──────────────────────────────────────────────

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    ship: { x: 240, y: 400, angle: 0 },
    asteroids: Array.from({ length: 8 }, () => ({
      x: Math.random() * 460 + 10,
      y: Math.random() * 300,
      r: Math.random() * 20 + 10,
      vx: (Math.random() - 0.5) * 2,
      vy: Math.random() * 1.5 + 0.5,
    })),
    bullets: [] as { x: number; y: number; vy: number }[],
    score: 0,
    keys: new Set<string>(),
  });

  const shoot = useCallback(() => {
    const s = stateRef.current;
    s.bullets.push({ x: s.ship.x, y: s.ship.y - 15, vy: -6 });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const handleKey = (e: KeyboardEvent) => {
      stateRef.current.keys.add(e.key);
      if (e.key === " ") { e.preventDefault(); shoot(); }
    };
    const handleKeyUp = (e: KeyboardEvent) => stateRef.current.keys.delete(e.key);

    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", handleKey);
    canvas.addEventListener("keyup", handleKeyUp);

    let raf: number;
    const loop = () => {
      const s = stateRef.current;
      const W = canvas.width, H = canvas.height;

      if (s.keys.has("ArrowLeft")) s.ship.x = Math.max(10, s.ship.x - 4);
      if (s.keys.has("ArrowRight")) s.ship.x = Math.min(W - 10, s.ship.x + 4);

      s.bullets = s.bullets.filter((b) => b.y > 0);
      s.bullets.forEach((b) => (b.y += b.vy));

      s.asteroids.forEach((a) => {
        a.x += a.vx;
        a.y += a.vy;
        if (a.y > H + 30) { a.y = -30; a.x = Math.random() * W; }
        if (a.x < -30) a.x = W + 30;
        if (a.x > W + 30) a.x = -30;
      });

      // Collision
      s.bullets.forEach((b) => {
        s.asteroids.forEach((a) => {
          const dx = b.x - a.x, dy = b.y - a.y;
          if (Math.sqrt(dx * dx + dy * dy) < a.r) {
            a.y = -30;
            a.x = Math.random() * W;
            b.y = -100;
            s.score += 10;
          }
        });
      });

      // Draw
      ctx.fillStyle = "#0a0a14";
      ctx.fillRect(0, 0, W, H);

      // Stars
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      for (let i = 0; i < 50; i++) {
        const sx = (i * 97 + s.score) % W;
        const sy = (i * 53 + i * i) % H;
        ctx.fillRect(sx, sy, 1, 1);
      }

      // Ship
      ctx.fillStyle = "#5af";
      ctx.beginPath();
      ctx.moveTo(s.ship.x, s.ship.y - 15);
      ctx.lineTo(s.ship.x - 10, s.ship.y + 10);
      ctx.lineTo(s.ship.x + 10, s.ship.y + 10);
      ctx.closePath();
      ctx.fill();

      // Bullets
      ctx.fillStyle = "#ff5";
      s.bullets.forEach((b) => ctx.fillRect(b.x - 1, b.y, 2, 8));

      // Asteroids
      s.asteroids.forEach((a) => {
        ctx.strokeStyle = "#888";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Score
      ctx.fillStyle = "#fff";
      ctx.font = "13px monospace";
      ctx.fillText(`Score: ${s.score}`, 10, 20);

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("keydown", handleKey);
      canvas.removeEventListener("keyup", handleKeyUp);
    };
  }, [shoot]);

  return (
    <div className="neri-content-game">
      <canvas ref={canvasRef} width={460} height={480} className="neri-game-canvas" />
      <div className="neri-game-hint">Click canvas to focus. Arrow keys to move, Space to shoot.</div>
    </div>
  );
}

// ─── System Monitor ─────────────────────────────────────────────────────

function SystemMonitor() {
  const [stats, setStats] = useState({
    cpu: 34,
    memory: 62,
    disk: 45,
    network: 12,
    processes: [
      { name: "stella-frontend", cpu: 12.4, mem: 340 },
      { name: "electron", cpu: 8.2, mem: 285 },
      { name: "node", cpu: 5.1, mem: 198 },
      { name: "convex-backend", cpu: 3.8, mem: 156 },
      { name: "chrome-helper", cpu: 2.1, mem: 124 },
      { name: "vite-dev", cpu: 1.5, mem: 89 },
    ],
  });

  useEffect(() => {
    const iv = setInterval(() => {
      setStats((s) => ({
        ...s,
        cpu: Math.max(5, Math.min(95, s.cpu + (Math.random() - 0.5) * 10)),
        memory: Math.max(30, Math.min(90, s.memory + (Math.random() - 0.5) * 4)),
        network: Math.max(0, Math.min(100, s.network + (Math.random() - 0.5) * 20)),
      }));
    }, 1500);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="neri-content-sysmon">
      <div className="neri-sysmon-bars">
        {[
          { label: "CPU", value: stats.cpu, color: "#5af" },
          { label: "Memory", value: stats.memory, color: "#f5a" },
          { label: "Disk", value: stats.disk, color: "#5fa" },
          { label: "Network", value: stats.network, color: "#fa5" },
        ].map((bar) => (
          <div key={bar.label} className="neri-sysmon-bar">
            <div className="neri-sysmon-bar-label">
              <span>{bar.label}</span>
              <span>{Math.round(bar.value)}%</span>
            </div>
            <div className="neri-sysmon-bar-track">
              <div
                className="neri-sysmon-bar-fill"
                style={{ width: `${bar.value}%`, background: bar.color, transition: "width 0.5s ease" }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="neri-sysmon-processes">
        <div className="neri-sysmon-proc-header">
          <span>Process</span><span>CPU %</span><span>Mem (MB)</span>
        </div>
        {stats.processes.map((p) => (
          <div key={p.name} className="neri-sysmon-proc-row">
            <span>{p.name}</span><span>{p.cpu.toFixed(1)}</span><span>{p.mem}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Weather ────────────────────────────────────────────────────────────

function Weather() {
  const forecast = [
    { day: "Mon", icon: "☀️", high: 28, low: 18 },
    { day: "Tue", icon: "⛅", high: 25, low: 17 },
    { day: "Wed", icon: "🌧️", high: 21, low: 15 },
    { day: "Thu", icon: "⛈️", high: 19, low: 13 },
    { day: "Fri", icon: "☀️", high: 26, low: 16 },
    { day: "Sat", icon: "☀️", high: 29, low: 19 },
    { day: "Sun", icon: "⛅", high: 24, low: 17 },
  ];

  return (
    <div className="neri-content-weather">
      <div className="neri-weather-current">
        <div className="neri-weather-temp">24°</div>
        <div className="neri-weather-desc">
          <div className="neri-weather-condition">Partly Cloudy</div>
          <div className="neri-weather-location">San Francisco, CA</div>
          <div className="neri-weather-details">
            <span>Humidity: 65%</span>
            <span>Wind: 12 km/h</span>
          </div>
        </div>
      </div>
      <div className="neri-weather-forecast">
        {forecast.map((f) => (
          <div key={f.day} className="neri-weather-day">
            <span className="neri-weather-day-name">{f.day}</span>
            <span className="neri-weather-day-icon">{f.icon}</span>
            <span className="neri-weather-day-temps">{f.high}° / {f.low}°</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Notes ──────────────────────────────────────────────────────────────

function Notes() {
  const [text, setText] = useState(
    "# Meeting Notes\n\n## Sprint Planning\n- Review backlog items\n- Assign story points\n- Set sprint goal\n\n## Action Items\n- [ ] Update API documentation\n- [ ] Fix login flow regression\n- [x] Deploy staging build\n- [x] Review PR #247\n\n## Ideas\nConsider implementing the neri-style tiling for workspace management...",
  );

  return (
    <div className="neri-content-notes">
      <div className="neri-notes-toolbar">
        <span className="neri-notes-btn">B</span>
        <span className="neri-notes-btn">I</span>
        <span className="neri-notes-btn">U</span>
        <span className="neri-notes-divider" />
        <span className="neri-notes-btn">H1</span>
        <span className="neri-notes-btn">H2</span>
        <span className="neri-notes-divider" />
        <span className="neri-notes-btn">•</span>
        <span className="neri-notes-btn">☐</span>
      </div>
      <textarea
        className="neri-notes-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="neri-notes-footer">{text.length} chars · {text.split("\n").length} lines</div>
    </div>
  );
}

// ─── File Browser ───────────────────────────────────────────────────────

const FILE_TREE = [
  { name: "stella/", type: "dir", indent: 0 },
  { name: "frontend/", type: "dir", indent: 1 },
  { name: "src/", type: "dir", indent: 2 },
  { name: "app/", type: "dir", indent: 3 },
  { name: "neri/", type: "dir", indent: 4 },
  { name: "NeriDashboard.tsx", type: "file", indent: 5, size: "12.4 KB" },
  { name: "neri.css", type: "file", indent: 5, size: "8.2 KB" },
  { name: "overlay/", type: "dir", indent: 4 },
  { name: "OverlayRoot.tsx", type: "file", indent: 5, size: "6.8 KB" },
  { name: "shell/", type: "dir", indent: 4 },
  { name: "FullShell.tsx", type: "file", indent: 5, size: "15.2 KB" },
  { name: "electron/", type: "dir", indent: 2 },
  { name: "main.ts", type: "file", indent: 3, size: "4.1 KB" },
  { name: "package.json", type: "file", indent: 2, size: "1.8 KB" },
  { name: "backend/", type: "dir", indent: 1 },
  { name: "convex/", type: "dir", indent: 2 },
  { name: "shared/", type: "dir", indent: 1 },
] as const;

function FileBrowser() {
  const [selected, setSelected] = useState(5);

  return (
    <div className="neri-content-files">
      <div className="neri-files-toolbar">
        <span className="neri-files-path">/stella/frontend/src/app/neri</span>
      </div>
      <div className="neri-files-list">
        {FILE_TREE.map((f, i) => (
          <div
            key={i}
            className={`neri-files-item ${i === selected ? "selected" : ""}`}
            style={{ paddingLeft: f.indent * 16 + 8 }}
            onClick={() => setSelected(i)}
          >
            <span className="neri-files-icon">{f.type === "dir" ? "📁" : "📄"}</span>
            <span className="neri-files-name">{f.name}</span>
            {"size" in f && <span className="neri-files-size">{f.size}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Search Window (voice action-driven)

function SearchWindow({ win }: { win: NeriWindow }) {
  const results = win.searchResults ?? [];

  const handleOpenUrl = (url: string) => {
    window.electronAPI?.system.openExternal?.(url);
  };

  return (
    <div className="neri-content-search-results">
      <div className="neri-search-results-header">
        <span className="neri-search-results-count">{results.length} results</span>
      </div>
      <div className="neri-search-results-list">
        {results.map((result, i) => (
          <div
            key={i}
            className="neri-search-result-card"
            onClick={() => handleOpenUrl(result.url)}
          >
            <div className="neri-search-result-title">{result.title}</div>
            <div className="neri-search-result-snippet">{result.snippet}</div>
            <div className="neri-search-result-url">{result.url}</div>
          </div>
        ))}
        {results.length === 0 && (
          <div className="neri-search-no-results">No results yet</div>
        )}
      </div>
    </div>
  );
}

// Canvas Window (voice action-driven)

function CanvasWindow({ win }: { win: NeriWindow }) {
  const html = win.canvasHtml ?? "";

  return (
    <div className="neri-content-canvas">
      <iframe
        srcDoc={html}
        sandbox="allow-scripts"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          background: "#fff",
          borderRadius: 4,
        }}
        title={win.title}
      />
    </div>
  );
}

// ─── Export ─────────────────────────────────────────────────────────────

export const NeriWindowContent = memo(function NeriWindowContent({ type, win }: { type: NeriWindowType; win?: NeriWindow }) {
  switch (type) {
    case "news-feed": return <NewsFeed />;
    case "music-player": return <MusicPlayer />;
    case "ai-search": return <AISearch />;
    case "calendar": return <Calendar />;
    case "game": return <Game />;
    case "system-monitor": return <SystemMonitor />;
    case "weather": return <Weather />;
    case "notes": return <Notes />;
    case "file-browser": return <FileBrowser />;
    case "search": return win ? <SearchWindow win={win} /> : null;
    case "canvas": return win ? <CanvasWindow win={win} /> : null;
  }
});
