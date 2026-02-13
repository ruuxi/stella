import { useState, useMemo } from "react";

type WeatherType = "sunny" | "partly-cloudy" | "cloudy" | "rainy" | "snowy";

type LocationData = {
  name: string;
  weather: WeatherType;
  condition: string;
  temp: number;
  humidity: string;
  wind: string;
  uv: string;
  pressure: string;
  visibility: string;
  dewPoint: number;
  forecast: { day: string; weather: WeatherType; high: number; low: number }[];
};

const LOCATIONS: LocationData[] = [
  {
    name: "San Francisco, CA",
    weather: "partly-cloudy",
    condition: "Partly Cloudy",
    temp: 72,
    humidity: "58%", wind: "12 mph", uv: "6", pressure: "30.1 in", visibility: "10 mi", dewPoint: 52,
    forecast: [
      { day: "Mon", weather: "partly-cloudy", high: 74, low: 58 },
      { day: "Tue", weather: "cloudy", high: 68, low: 54 },
      { day: "Wed", weather: "rainy", high: 61, low: 50 },
      { day: "Thu", weather: "partly-cloudy", high: 65, low: 52 },
      { day: "Fri", weather: "sunny", high: 70, low: 55 },
      { day: "Sat", weather: "sunny", high: 76, low: 59 },
      { day: "Sun", weather: "partly-cloudy", high: 73, low: 57 },
    ],
  },
  {
    name: "New York, NY",
    weather: "rainy",
    condition: "Light Rain",
    temp: 55,
    humidity: "82%", wind: "18 mph", uv: "2", pressure: "29.8 in", visibility: "5 mi", dewPoint: 48,
    forecast: [
      { day: "Mon", weather: "rainy", high: 56, low: 44 },
      { day: "Tue", weather: "rainy", high: 52, low: 42 },
      { day: "Wed", weather: "cloudy", high: 58, low: 46 },
      { day: "Thu", weather: "partly-cloudy", high: 62, low: 48 },
      { day: "Fri", weather: "sunny", high: 65, low: 50 },
      { day: "Sat", weather: "partly-cloudy", high: 60, low: 47 },
      { day: "Sun", weather: "rainy", high: 54, low: 43 },
    ],
  },
  {
    name: "London, UK",
    weather: "cloudy",
    condition: "Overcast",
    temp: 48,
    humidity: "76%", wind: "14 mph", uv: "1", pressure: "30.0 in", visibility: "7 mi", dewPoint: 40,
    forecast: [
      { day: "Mon", weather: "cloudy", high: 50, low: 40 },
      { day: "Tue", weather: "rainy", high: 47, low: 38 },
      { day: "Wed", weather: "rainy", high: 45, low: 37 },
      { day: "Thu", weather: "cloudy", high: 49, low: 39 },
      { day: "Fri", weather: "partly-cloudy", high: 52, low: 41 },
      { day: "Sat", weather: "cloudy", high: 48, low: 38 },
      { day: "Sun", weather: "partly-cloudy", high: 51, low: 40 },
    ],
  },
  {
    name: "Tokyo, JP",
    weather: "sunny",
    condition: "Clear Sky",
    temp: 82,
    humidity: "45%", wind: "8 mph", uv: "8", pressure: "30.2 in", visibility: "12 mi", dewPoint: 58,
    forecast: [
      { day: "Mon", weather: "sunny", high: 84, low: 68 },
      { day: "Tue", weather: "sunny", high: 86, low: 70 },
      { day: "Wed", weather: "partly-cloudy", high: 80, low: 66 },
      { day: "Thu", weather: "rainy", high: 74, low: 62 },
      { day: "Fri", weather: "rainy", high: 72, low: 60 },
      { day: "Sat", weather: "partly-cloudy", high: 78, low: 64 },
      { day: "Sun", weather: "sunny", high: 83, low: 67 },
    ],
  },
];

const WEATHER_ICON: Record<WeatherType, string> = {
  sunny: "☀️",
  "partly-cloudy": "🌤",
  cloudy: "☁️",
  rainy: "🌧",
  snowy: "🌨",
};

/* ── Animated weather effects (CSS) ── */

const css = `
  .wx-root { position: relative; padding: 24px; display: flex; flex-direction: column; gap: 20px; height: 100%; font-family: var(--font-family-sans, Inter, sans-serif); color: var(--foreground); background: transparent; overflow: hidden; }
  .wx-root * { box-sizing: border-box; }

  /* ── Hero scene container ── */
  .wx-hero { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 20px 0 12px; overflow: hidden; border-radius: 12px; }

  /* ── Sun rays ── */
  .wx-sun-rays { position: absolute; top: -20px; left: 50%; width: 180px; height: 180px; transform: translateX(-50%); pointer-events: none; opacity: 0; transition: opacity 0.6s ease; }
  .wx-hero[data-weather="sunny"] .wx-sun-rays,
  .wx-hero[data-weather="partly-cloudy"] .wx-sun-rays { opacity: 1; }
  .wx-hero[data-weather="partly-cloudy"] .wx-sun-rays { opacity: 0.5; }

  .wx-sun-ray {
    position: absolute;
    top: 50%; left: 50%;
    width: 2px; height: 60px;
    background: linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 8%, transparent), transparent);
    transform-origin: top center;
    animation: wx-ray-pulse 4s ease-in-out infinite;
  }

  @keyframes wx-ray-pulse {
    0%, 100% { opacity: 0.3; height: 60px; }
    50% { opacity: 0.7; height: 75px; }
  }

  /* ── Rain ── */
  .wx-rain { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; opacity: 0; transition: opacity 0.6s ease; overflow: hidden; }
  .wx-hero[data-weather="rainy"] .wx-rain { opacity: 1; }

  .wx-raindrop {
    position: absolute;
    width: 1.5px;
    background: linear-gradient(to bottom, transparent, color-mix(in oklch, var(--foreground) 15%, transparent));
    border-radius: 0 0 1px 1px;
    animation: wx-fall linear infinite;
  }

  @keyframes wx-fall {
    0% { transform: translateY(-20px); opacity: 0; }
    10% { opacity: 1; }
    90% { opacity: 1; }
    100% { transform: translateY(160px); opacity: 0; }
  }

  /* ── Clouds ── */
  .wx-clouds { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; opacity: 0; transition: opacity 0.6s ease; overflow: hidden; }
  .wx-hero[data-weather="cloudy"] .wx-clouds { opacity: 1; }
  .wx-hero[data-weather="rainy"] .wx-clouds { opacity: 0.6; }
  .wx-hero[data-weather="partly-cloudy"] .wx-clouds { opacity: 0.4; }

  .wx-cloud {
    position: absolute;
    border-radius: 50px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    backdrop-filter: blur(2px);
    animation: wx-drift linear infinite;
  }

  @keyframes wx-drift {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(calc(100% + 300px)); }
  }

  /* ── Forecast row icon animations ── */
  .wx-forecast-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; }

  .wx-forecast-icon[data-weather="rainy"]::after {
    content: "";
    position: absolute;
    bottom: 0; left: 50%;
    width: 14px; height: 8px;
    transform: translateX(-50%);
    background: repeating-linear-gradient(
      transparent 0px,
      transparent 2px,
      color-mix(in oklch, var(--foreground) 12%, transparent) 2px,
      color-mix(in oklch, var(--foreground) 12%, transparent) 3px
    );
    animation: wx-mini-rain 0.8s linear infinite;
    opacity: 0.6;
    border-radius: 0 0 2px 2px;
  }

  @keyframes wx-mini-rain {
    0% { transform: translateX(-50%) translateY(0); opacity: 0.6; }
    100% { transform: translateX(-50%) translateY(4px); opacity: 0; }
  }

  .wx-forecast-icon[data-weather="sunny"]::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in oklch, var(--foreground) 5%, transparent) 30%, transparent 70%);
    animation: wx-glow 3s ease-in-out infinite;
  }

  @keyframes wx-glow {
    0%, 100% { opacity: 0.4; transform: scale(1); }
    50% { opacity: 0.8; transform: scale(1.15); }
  }

  .wx-forecast-icon[data-weather="cloudy"]::after {
    content: "";
    position: absolute;
    bottom: 2px; left: 2px;
    width: 10px; height: 5px;
    border-radius: 10px;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    animation: wx-cloud-bob 3s ease-in-out infinite;
  }

  @keyframes wx-cloud-bob {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(4px); }
  }
`;

/* ── Rain drops generator ── */
function RainEffect() {
  const drops = useMemo(() =>
    Array.from({ length: 30 }, (_, i) => ({
      left: `${(i / 30) * 100 + Math.sin(i * 2.3) * 3}%`,
      height: `${12 + Math.sin(i * 1.7) * 6}px`,
      duration: `${0.6 + Math.sin(i * 0.9) * 0.3}s`,
      delay: `${(i / 30) * 0.8}s`,
    })),
  []);

  return (
    <div className="wx-rain">
      {drops.map((d, i) => (
        <div
          key={i}
          className="wx-raindrop"
          style={{ left: d.left, height: d.height, animationDuration: d.duration, animationDelay: d.delay }}
        />
      ))}
    </div>
  );
}

/* ── Cloud layer generator ── */
function CloudEffect() {
  const clouds = useMemo(() => [
    { top: "15%", width: 80, height: 24, duration: "18s", delay: "0s" },
    { top: "30%", width: 60, height: 18, duration: "22s", delay: "-6s" },
    { top: "50%", width: 100, height: 28, duration: "25s", delay: "-12s" },
    { top: "20%", width: 50, height: 16, duration: "20s", delay: "-3s" },
  ], []);

  return (
    <div className="wx-clouds">
      {clouds.map((c, i) => (
        <div
          key={i}
          className="wx-cloud"
          style={{ top: c.top, width: c.width, height: c.height, animationDuration: c.duration, animationDelay: c.delay }}
        />
      ))}
    </div>
  );
}

/* ── Sun rays generator ── */
function SunRays() {
  const rays = useMemo(() =>
    Array.from({ length: 12 }, (_, i) => ({
      rotation: (i / 12) * 360,
      delay: `${(i / 12) * 4}s`,
    })),
  []);

  return (
    <div className="wx-sun-rays">
      {rays.map((r, i) => (
        <div
          key={i}
          className="wx-sun-ray"
          style={{ transform: `rotate(${r.rotation}deg)`, animationDelay: r.delay }}
        />
      ))}
    </div>
  );
}

export default function WeatherStation() {
  const [locationIdx, setLocationIdx] = useState(1);
  const [unit, setUnit] = useState<"F" | "C">("F");

  const loc = LOCATIONS[locationIdx];
  const toUnit = (f: number) => (unit === "F" ? f : Math.round(((f - 32) * 5) / 9));

  return (
    <>
      <style>{css}</style>
      <div className="wx-root">
        {/* Location Picker */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <select
            value={locationIdx}
            onChange={(e) => setLocationIdx(Number(e.target.value))}
            style={{
              background: "color-mix(in oklch, var(--foreground) 5%, transparent)",
              border: "1px solid color-mix(in oklch, var(--foreground) 10%, transparent)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            {LOCATIONS.map((l, i) => (
              <option key={l.name} value={i}>{l.name}</option>
            ))}
          </select>
          <div style={{ display: "flex", gap: 4 }}>
            {(["F", "C"] as const).map((u) => (
              <button
                key={u}
                onClick={() => setUnit(u)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid color-mix(in oklch, var(--foreground) 10%, transparent)",
                  background: unit === u ? "color-mix(in oklch, var(--interactive) 15%, transparent)" : "transparent",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--foreground)",
                  cursor: "pointer",
                }}
              >
                °{u}
              </button>
            ))}
          </div>
        </div>

        {/* Hero with weather effects */}
        <div className="wx-hero" data-weather={loc.weather}>
          <SunRays />
          <CloudEffect />
          <RainEffect />
          <span style={{ fontSize: 48, lineHeight: 1, position: "relative", zIndex: 1 }}>{WEATHER_ICON[loc.weather]}</span>
          <span style={{ fontSize: 48, fontWeight: 200, opacity: 0.9, lineHeight: 1, position: "relative", zIndex: 1 }}>{toUnit(loc.temp)}°</span>
          <span style={{ fontSize: 14, opacity: 0.5, marginTop: 4, position: "relative", zIndex: 1 }}>{loc.condition}</span>
          <span style={{ fontSize: 12, opacity: 0.3, position: "relative", zIndex: 1 }}>{loc.name}</span>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[
            { label: "Humidity", value: loc.humidity },
            { label: "Wind", value: loc.wind },
            { label: "UV Index", value: loc.uv },
            { label: "Pressure", value: loc.pressure },
            { label: "Visibility", value: loc.visibility },
            { label: "Dew Point", value: `${toUnit(loc.dewPoint)}°` },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "10px 8px",
                borderRadius: 8,
                border: "1px solid color-mix(in oklch, var(--foreground) 7%, transparent)",
                background: "color-mix(in oklch, var(--foreground) 2%, transparent)",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, opacity: 0.35 }}>{s.label}</span>
              <span style={{ fontSize: 15, fontWeight: 300, opacity: 0.8 }}>{s.value}</span>
            </div>
          ))}
        </div>

        {/* Forecast */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, opacity: 0.35 }}>7-Day Forecast</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, overflow: "auto" }}>
            {loc.forecast.map((d) => (
              <div
                key={d.day}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid color-mix(in oklch, var(--foreground) 6%, transparent)",
                  background: "color-mix(in oklch, var(--foreground) 2%, transparent)",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.6, width: 36 }}>{d.day}</span>
                <span className="wx-forecast-icon" data-weather={d.weather} style={{ fontSize: 20 }}>{WEATHER_ICON[d.weather]}</span>
                <span style={{ fontSize: 13, opacity: 0.8, fontWeight: 400 }}>{toUnit(d.high)}°</span>
                <span style={{ fontSize: 12, opacity: 0.35, fontWeight: 300 }}>{toUnit(d.low)}°</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
