import { useState } from "react";

/* ── Types ── */

type WeatherType = "sunny" | "partly-cloudy" | "cloudy" | "rainy" | "snowy";

type LocationData = {
  name: string;
  weather: WeatherType;
  condition: string;
  temp: number;
  feelsLike: number;
  high: number;
  low: number;
  humidity: string;
  wind: string;
  uv: string;
  pressure: string;
  visibility: string;
  dewPoint: number;
  forecast: { day: string; weather: WeatherType; high: number; low: number }[];
};

/* ── Location Data ── */

const LOCATIONS: LocationData[] = [
  {
    name: "San Francisco, CA",
    weather: "partly-cloudy",
    condition: "Partly Cloudy",
    temp: 72,
    feelsLike: 70,
    high: 74,
    low: 58,
    humidity: "58%", wind: "12 mph W", uv: "6 Moderate", pressure: "30.1 in", visibility: "10 mi", dewPoint: 52,
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
    feelsLike: 51,
    high: 56,
    low: 44,
    humidity: "82%", wind: "18 mph NE", uv: "2 Low", pressure: "29.8 in", visibility: "5 mi", dewPoint: 48,
    forecast: [
      { day: "Mon", weather: "rainy", high: 56, low: 44 },
      { day: "Tue", weather: "rainy", high: 52, low: 42 },
      { day: "Wed", weather: "cloudy", high: 58, low: 46 },
      { day: "Thu", weather: "partly-cloudy", high: 62, low: 48 },
      { day: "Fri", weather: "sunny", high: 65, low: 50 },
      { day: "Sat", weather: "sunny", high: 72, low: 52 },
      { day: "Sun", weather: "partly-cloudy", high: 60, low: 47 },
    ],
  },
  {
    name: "London, UK",
    weather: "cloudy",
    condition: "Overcast",
    temp: 48,
    feelsLike: 44,
    high: 50,
    low: 40,
    humidity: "76%", wind: "14 mph SW", uv: "1 Low", pressure: "30.0 in", visibility: "7 mi", dewPoint: 40,
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
    feelsLike: 85,
    high: 84,
    low: 68,
    humidity: "45%", wind: "8 mph SE", uv: "8 Very High", pressure: "30.2 in", visibility: "12 mi", dewPoint: 58,
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

/* ── Hourly chart data ── */

const HOURLY_TEMPS = [55, 54, 52, 51, 50, 49, 50, 52, 54, 56, 58, 60];
const HOURLY_LABELS = ["Now", "", "", "3PM", "", "", "6PM", "", "", "9PM", "", "12AM"];

/* ── SVG Weather Icons ── */

function SunIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function CloudIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

function RainIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      <line x1="8" y1="19" x2="7" y2="22" />
      <line x1="12" y1="19" x2="11" y2="22" />
      <line x1="16" y1="19" x2="15" y2="22" />
    </svg>
  );
}

function PartlyCloudyIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3.5" />
      <line x1="8" y1="1.5" x2="8" y2="2.5" />
      <line x1="8" y1="13.5" x2="8" y2="14.5" />
      <line x1="3.05" y1="3.05" x2="3.76" y2="3.76" />
      <line x1="12.24" y1="12.24" x2="12.95" y2="12.95" />
      <line x1="1.5" y1="8" x2="2.5" y2="8" />
      <line x1="3.05" y1="12.95" x2="3.76" y2="12.24" />
      <path d="M20 15h-1.26A6.5 6.5 0 0 0 7.5 17h12.5a4 4 0 0 0 0-8 4 4 0 0 0-3.5 2" />
    </svg>
  );
}

function getWeatherIcon(type: WeatherType, size = 24) {
  switch (type) {
    case "sunny": return <SunIcon size={size} />;
    case "cloudy": return <CloudIcon size={size} />;
    case "rainy": return <RainIcon size={size} />;
    case "partly-cloudy": return <PartlyCloudyIcon size={size} />;
    case "snowy": return <CloudIcon size={size} />;
  }
}

/* ── Large hero rain icon (cloud with 3 drops) ── */

function HeroRainIcon({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M42 22h-2.52A16 16 0 1 0 18 40h24a10 10 0 0 0 0-20z" />
      <line x1="18" y1="42" x2="16" y2="50" />
      <line x1="28" y1="42" x2="26" y2="50" />
      <line x1="38" y1="42" x2="36" y2="50" />
    </svg>
  );
}

/* ── Stat icons ── */

function DropletIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
    </svg>
  );
}

function WindIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.59 4.59A2 2 0 1 1 11 8H2" />
      <path d="M12.59 19.41A2 2 0 1 0 14 16H2" />
      <path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2" />
    </svg>
  );
}

function UVIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="6.76" y2="6.76" />
      <line x1="17.24" y1="17.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="6.76" y2="17.24" />
      <line x1="17.24" y1="6.76" x2="19.07" y2="4.93" />
    </svg>
  );
}

function PressureIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="12" x2="16" y2="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function EyeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ThermometerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
    </svg>
  );
}

function LightbulbIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A7 7 0 1 0 7.5 11.5c.76.76 1.23 1.52 1.41 2.5" />
    </svg>
  );
}

function CompassIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" opacity="0.3" stroke="currentColor" />
    </svg>
  );
}

/* ── Hourly Chart ── */

function HourlyChart({ temps, unit }: { temps: number[]; unit: "F" | "C" }) {
  const toUnit = (f: number) => (unit === "F" ? f : Math.round(((f - 32) * 5) / 9));
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const range = max - min || 1;

  const points = temps.map((t, i) => {
    const x = (i / (temps.length - 1)) * 380 + 10;
    const y = 65 - ((t - min) / range) * 55 + 10;
    return { x, y, t };
  });

  const polyline = points.map(p => `${p.x},${p.y}`).join(" ");
  const areaPath = `M${points[0].x},${points[0].y} ${points.map(p => `L${p.x},${p.y}`).join(" ")} L${points[points.length - 1].x},75 L${points[0].x},75 Z`;

  const labelIndices = [0, 3, 6, 9, 11];

  return (
    <svg viewBox="0 0 400 100" style={{ width: "100%", height: 100, display: "block" }}>
      <defs>
        <linearGradient id="wxChartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.65 0.15 240)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="oklch(0.65 0.15 240)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#wxChartFill)" />
      <polyline points={polyline} fill="none" stroke="oklch(0.65 0.15 240)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="oklch(0.65 0.15 240)" />
      ))}
      {labelIndices.map(i => (
        <text key={`t-${i}`} x={points[i].x} y={points[i].y - 8} textAnchor="middle" fill="var(--foreground)" fontSize="9" opacity="0.7" fontFamily="inherit">
          {toUnit(points[i].t)}
        </text>
      ))}
      {HOURLY_LABELS.map((label, i) =>
        label ? (
          <text key={`l-${i}`} x={points[i].x} y="95" textAnchor="middle" fill="var(--foreground)" fontSize="8" opacity="0.4" fontFamily="inherit">
            {label}
          </text>
        ) : null
      )}
    </svg>
  );
}

/* ── CSS ── */

const ACCENT = "oklch(0.65 0.15 240)";

const css = `
.ws-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  font-family: var(--font-family-sans, "Satoshi", sans-serif);
  color: var(--foreground);
  background: var(--background);
  overflow: hidden;
}
.ws-root * { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Header ── */
.ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 36px;
  border-bottom: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
  flex-shrink: 0;
}
.ws-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ws-header-title {
  font-size: 15px;
  font-weight: 600;
  opacity: 0.85;
}
.ws-header-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.4;
}
.ws-header-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: oklch(0.72 0.19 145);
  flex-shrink: 0;
}
.ws-header-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ── Weather Dashboard ── */
.ws-dashboard {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 28px 36px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.ws-dashboard::-webkit-scrollbar { display: none; }

/* Hero */
.ws-hero {
  display: flex;
  align-items: flex-start;
  gap: 24px;
}
.ws-hero-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ws-hero-location {
  font-size: 18px;
  font-weight: 600;
  opacity: 0.85;
}
.ws-hero-condition {
  font-size: 13px;
  opacity: 0.45;
  margin-bottom: 4px;
}
.ws-hero-temp {
  font-size: 48px;
  font-weight: 200;
  line-height: 1;
  opacity: 0.9;
}
.ws-hero-detail {
  font-size: 12px;
  opacity: 0.4;
  margin-top: 6px;
}
.ws-hero-icon {
  color: color-mix(in oklch, var(--foreground) 35%, transparent);
  flex-shrink: 0;
  margin-top: 4px;
}

/* Controls */
.ws-select {
  background: color-mix(in oklch, var(--foreground) 4%, transparent);
  border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  color: var(--foreground);
  cursor: pointer;
  font-family: inherit;
  outline: none;
}
.ws-select option {
  background: var(--background);
  color: var(--foreground);
}
.ws-unit-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
  background: transparent;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--foreground);
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.ws-unit-btn[data-active="true"] {
  background: color-mix(in oklch, ${ACCENT} 15%, transparent);
}

/* Section label */
.ws-section-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.35;
  margin-bottom: 8px;
}

/* Hourly chart container */
.ws-hourly {
  border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
  border-radius: 10px;
  padding: 14px 10px 4px;
  background: color-mix(in oklch, var(--foreground) 1.5%, transparent);
}

/* Stats grid */
.ws-stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}
.ws-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
  background: color-mix(in oklch, var(--foreground) 1.5%, transparent);
}
.ws-stat-icon {
  color: color-mix(in oklch, var(--foreground) 35%, transparent);
}
.ws-stat-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.35;
}
.ws-stat-value {
  font-size: 15px;
  font-weight: 300;
  opacity: 0.8;
}

/* Insight cards */
.ws-insight {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 10px;
  border-left: 3px solid color-mix(in oklch, ${ACCENT} 40%, transparent);
  background: color-mix(in oklch, ${ACCENT} 6%, transparent);
}
.ws-insight-icon {
  color: ${ACCENT};
  flex-shrink: 0;
  margin-top: 1px;
}
.ws-insight-text {
  font-size: 12.5px;
  line-height: 1.55;
  opacity: 0.75;
}

/* 7-day forecast row */
.ws-forecast-row {
  display: flex;
  gap: 6px;
}
.ws-day-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 4px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
  background: color-mix(in oklch, var(--foreground) 1.5%, transparent);
}
.ws-day-name {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.5;
}
.ws-day-icon {
  color: color-mix(in oklch, var(--foreground) 40%, transparent);
}
.ws-day-high {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.8;
}
.ws-day-low {
  font-size: 11px;
  opacity: 0.35;
  font-weight: 300;
}
`;

/* ── Main Component ── */

export function WeatherStation() {
  const [locationIdx, setLocationIdx] = useState(1);
  const [unit, setUnit] = useState<"F" | "C">("F");

  const loc = LOCATIONS[locationIdx];
  const toUnit = (f: number) => (unit === "F" ? f : Math.round(((f - 32) * 5) / 9));

  return (
    <>
      <style>{css}</style>
      <div className="ws-root">
        {/* ── Header ── */}
        <div className="ws-header">
          <div className="ws-header-left">
            <div className="ws-header-title">Stella Weather</div>
            <div className="ws-header-status">
              <div className="ws-header-dot" />
              Live
            </div>
          </div>
          <div className="ws-header-controls">
            <select
              className="ws-select"
              value={locationIdx}
              onChange={(e) => setLocationIdx(Number(e.target.value))}
            >
              {LOCATIONS.map((l, i) => (
                <option key={l.name} value={i}>{l.name}</option>
              ))}
            </select>
            <button className="ws-unit-btn" data-active={unit === "F"} onClick={() => setUnit("F")}>°F</button>
            <button className="ws-unit-btn" data-active={unit === "C"} onClick={() => setUnit("C")}>°C</button>
          </div>
        </div>

        {/* ── Weather Dashboard ── */}
        <div className="ws-dashboard">
          {/* Current Conditions Hero */}
          <div className="ws-hero">
            <div className="ws-hero-main">
              <div className="ws-hero-location">{loc.name}</div>
              <div className="ws-hero-condition">{loc.condition}</div>
              <div className="ws-hero-temp">{toUnit(loc.temp)}</div>
              <div className="ws-hero-detail">
                Feels like {toUnit(loc.feelsLike)} &middot; H:{toUnit(loc.high)} L:{toUnit(loc.low)}
              </div>
            </div>
            <div className="ws-hero-icon">
              {loc.weather === "rainy" && <HeroRainIcon size={56} />}
              {loc.weather === "sunny" && <SunIcon size={56} />}
              {loc.weather === "cloudy" && <CloudIcon size={56} />}
              {loc.weather === "partly-cloudy" && <PartlyCloudyIcon size={56} />}
              {loc.weather === "snowy" && <CloudIcon size={56} />}
            </div>
          </div>

          {/* Hourly Forecast Chart */}
          <div>
            <div className="ws-section-label">Hourly Forecast</div>
            <div className="ws-hourly">
              <HourlyChart temps={HOURLY_TEMPS} unit={unit} />
            </div>
          </div>

          {/* Stats Grid */}
          <div>
            <div className="ws-section-label">Conditions</div>
            <div className="ws-stats">
              <div className="ws-stat">
                <div className="ws-stat-icon"><DropletIcon /></div>
                <div className="ws-stat-label">Humidity</div>
                <div className="ws-stat-value">{loc.humidity}</div>
              </div>
              <div className="ws-stat">
                <div className="ws-stat-icon"><WindIcon /></div>
                <div className="ws-stat-label">Wind</div>
                <div className="ws-stat-value">{loc.wind}</div>
              </div>
              <div className="ws-stat">
                <div className="ws-stat-icon"><UVIcon /></div>
                <div className="ws-stat-label">UV Index</div>
                <div className="ws-stat-value">{loc.uv}</div>
              </div>
              <div className="ws-stat">
                <div className="ws-stat-icon"><PressureIcon /></div>
                <div className="ws-stat-label">Pressure</div>
                <div className="ws-stat-value">{loc.pressure}</div>
              </div>
              <div className="ws-stat">
                <div className="ws-stat-icon"><EyeIcon /></div>
                <div className="ws-stat-label">Visibility</div>
                <div className="ws-stat-value">{loc.visibility}</div>
              </div>
              <div className="ws-stat">
                <div className="ws-stat-icon"><ThermometerIcon /></div>
                <div className="ws-stat-label">Dew Point</div>
                <div className="ws-stat-value">{toUnit(loc.dewPoint)}</div>
              </div>
            </div>
          </div>

          {/* Stella Insights */}
          <div>
            <div className="ws-section-label">Stella Insights</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="ws-insight">
                <div className="ws-insight-icon"><LightbulbIcon size={18} /></div>
                <div className="ws-insight-text">Leave 10 minutes early -- wet roads and reduced visibility today.</div>
              </div>
              <div className="ws-insight">
                <div className="ws-insight-icon"><CompassIcon size={18} /></div>
                <div className="ws-insight-text">Saturday: ideal for your planned hike. High of 72 F, clear skies.</div>
              </div>
              <div className="ws-insight">
                <div className="ws-insight-icon"><LightbulbIcon size={18} /></div>
                <div className="ws-insight-text">I moved your 2pm outdoor meeting indoors -- Conference Room B.</div>
              </div>
            </div>
          </div>

          {/* 7-Day Forecast */}
          <div>
            <div className="ws-section-label">7-Day Forecast</div>
            <div className="ws-forecast-row">
              {loc.forecast.map((d) => (
                <div className="ws-day-card" key={d.day}>
                  <div className="ws-day-name">{d.day}</div>
                  <div className="ws-day-icon">{getWeatherIcon(d.weather, 18)}</div>
                  <div className="ws-day-high">{toUnit(d.high)}</div>
                  <div className="ws-day-low">{toUnit(d.low)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
