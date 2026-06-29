import { useEffect, useMemo, useRef, useState } from "react";

import { uiState } from "@/platform/ui-state";

/**
 * Daily Discipline Tracker — Rahul's comeback dashboard.
 *
 * A calm, monastic daily habit + streak tracker. Two surfaces:
 *   - Today: the morning checklist for the selected day, a completion
 *     ring, the overall streak, and an optional one-line journal.
 *   - The Chain: a "don't break the chain" heatmap of consistency over
 *     time, headline stats, and per-habit streaks.
 *
 * Everything persists through Stella's shared UI-state store, so history
 * and streaks survive across sessions and windows.
 */

export const meta = {
  label: "Daily Discipline Tracker",
  createdAt: "2026-06-29T07:19:16.265Z",
};

// ── Types ───────────────────────────────────────────────────────────────────

type Polarity = "build" | "resist";

interface Habit {
  id: string;
  name: string;
  detail: string;
  polarity: Polarity;
}

interface DayRecord {
  done: Record<string, boolean>;
  note: string;
  total: number;
}

type Days = Record<string, DayRecord>;

interface Store {
  habits: Habit[];
  days: Days;
  startedAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORE_KEY = "stella:discipline:v1";

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const seedHabits = (): Habit[] =>
  [
    ["Wake 8:00am", "Up with the alarm, no snooze", "build"],
    ["Cold shower", "First thing, no negotiation", "build"],
    ["Morning stretch", "Loosen up before the day", "build"],
    ["Gym + run", "Train and move with intent", "build"],
    ["Hourly movement", "Squats or pushups every hour", "build"],
    ["Clean eating", "Low carb, no junk, water only", "build"],
    ["Sleep early", "Wind down, lights out on time", "build"],
    ["No nicotine", "Cold turkey", "resist"],
    ["No social media", "Stay off the feeds", "resist"],
    ["Deliberate boredom", "10+ min, no phone", "build"],
    ["Daily reading", "Read something worthwhile", "build"],
  ].map(([name, detail, polarity]) => ({
    id: newId(),
    name: name as string,
    detail: detail as string,
    polarity: polarity as Polarity,
  }));

const loadStore = (): Store => {
  try {
    const raw = uiState.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(parsed.habits) && parsed.days && parsed.startedAt) {
        return {
          habits: parsed.habits,
          days: parsed.days,
          startedAt: parsed.startedAt,
        };
      }
    }
  } catch {
    // fall through to a fresh seeded store
  }
  return { habits: seedHabits(), days: {}, startedAt: toKey(new Date()) };
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function longDate(d: Date): string {
  return `${WEEKDAY[d.getDay()]}, ${MONTH[d.getMonth()]} ${d.getDate()}`;
}

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [store, setStore] = useState<Store>(loadStore);
  const { habits, days, startedAt } = store;

  const loadedRef = useRef(false);
  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      return;
    }
    try {
      uiState.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      // best-effort persistence
    }
  }, [store]);

  const [tab, setTab] = useState<"today" | "chain">("today");
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string>(() => toKey(new Date()));

  const todayKey = toKey(new Date());
  const now = new Date();
  const activeCount = habits.length;

  // ── derived: completion + streaks ──
  const recordFor = (k: string): DayRecord | undefined => days[k];

  const doneCountFor = (k: string): number => {
    const rec = days[k];
    if (!rec) return 0;
    return habits.reduce((n, h) => n + (rec.done[h.id] ? 1 : 0), 0);
  };

  const totalFor = (k: string): number => {
    if (k === todayKey) return activeCount;
    const rec = days[k];
    return rec && rec.total > 0 ? rec.total : activeCount;
  };

  const dayComplete = (k: string): boolean => {
    const total = totalFor(k);
    return total > 0 && doneCountFor(k) >= total;
  };

  const dayRatio = (k: string): number => {
    const total = totalFor(k);
    if (total <= 0) return 0;
    return Math.min(1, doneCountFor(k) / total);
  };

  const habitStreak = (habitId: string): number => {
    const doneOn = (k: string) => !!days[k]?.done?.[habitId];
    let cursor = fromKey(todayKey);
    if (!doneOn(todayKey)) cursor = addDays(cursor, -1);
    let count = 0;
    while (doneOn(toKey(cursor))) {
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
  };

  const overallStreak = useMemo(() => {
    let cursor = fromKey(todayKey);
    if (!dayComplete(todayKey)) cursor = addDays(cursor, -1);
    let count = 0;
    while (dayComplete(toKey(cursor))) {
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, habits, todayKey]);

  const stats = useMemo(() => {
    const start = fromKey(startedAt);
    const end = fromKey(todayKey);
    let longest = 0;
    let run = 0;
    let perfectDays = 0;
    let activeDays = 0;
    let cursor = new Date(start);
    while (cursor <= end) {
      const k = toKey(cursor);
      const rec = days[k];
      if (rec && doneCountFor(k) > 0) activeDays += 1;
      if (dayComplete(k)) {
        perfectDays += 1;
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
      cursor = addDays(cursor, 1);
    }
    const totalDays =
      Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    return { longest, perfectDays, activeDays, totalDays };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, habits, startedAt, todayKey]);

  const dayNumber =
    Math.round(
      (fromKey(todayKey).getTime() - fromKey(startedAt).getTime()) / 86400000,
    ) + 1;

  // ── mutations ──
  const ensureRecord = (k: string, prev: Days): DayRecord =>
    prev[k]
      ? { ...prev[k], done: { ...prev[k].done } }
      : { done: {}, note: "", total: activeCount };

  const toggleHabit = (habitId: string) => {
    setStore((s) => {
      const rec = ensureRecord(selected, s.days);
      if (rec.done[habitId]) delete rec.done[habitId];
      else rec.done[habitId] = true;
      if (!s.days[selected]) rec.total = activeCount;
      return { ...s, days: { ...s.days, [selected]: rec } };
    });
  };

  const setNote = (text: string) => {
    setStore((s) => {
      const rec = ensureRecord(selected, s.days);
      rec.note = text;
      return { ...s, days: { ...s.days, [selected]: rec } };
    });
  };

  const addHabit = (name: string, detail: string, polarity: Polarity) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setStore((s) => ({
      ...s,
      habits: [
        ...s.habits,
        { id: newId(), name: trimmed, detail: detail.trim(), polarity },
      ],
    }));
  };

  const updateHabit = (id: string, patch: Partial<Habit>) => {
    setStore((s) => ({
      ...s,
      habits: s.habits.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  };

  const removeHabit = (id: string) => {
    setStore((s) => ({ ...s, habits: s.habits.filter((h) => h.id !== id) }));
  };

  const moveHabit = (id: string, dir: -1 | 1) => {
    setStore((s) => {
      const idx = s.habits.findIndex((h) => h.id === id);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= s.habits.length) return s;
      const arr = [...s.habits];
      const [item] = arr.splice(idx, 1);
      arr.splice(next, 0, item);
      return { ...s, habits: arr };
    });
  };

  const selectedRec = recordFor(selected);
  const selectedDone = doneCountFor(selected);
  const selectedTotal = totalFor(selected);
  const selectedComplete = dayComplete(selected);
  const isToday = selected === todayKey;
  const selDate = fromKey(selected);

  return (
    <div className="dd-root">
      <style>{CSS}</style>

      <header className="dd-hero">
        <div className="dd-hero-text">
          <p className="dd-eyebrow">
            Day {dayNumber} of the rebuild
            <span className="dd-eyebrow-dot" />
            {longDate(now)}
          </p>
          <h1 className="dd-title">
            {greeting(now)}, <em>Rahul</em>.
          </h1>
          <p className="dd-sub">
            {overallStreak > 0
              ? `${overallStreak} day${overallStreak === 1 ? "" : "s"} unbroken. Hold the line.`
              : "A clean slate. Earn today back."}
          </p>
        </div>

        <div className="dd-hero-streak">
          <span className="dd-streak-num">{overallStreak}</span>
          <span className="dd-streak-label">day streak</span>
        </div>
      </header>

      <nav className="dd-tabs" role="tablist" aria-label="Views">
        <button
          role="tab"
          aria-selected={tab === "today"}
          className={`dd-tab ${tab === "today" ? "is-on" : ""}`}
          onClick={() => setTab("today")}
        >
          Today
        </button>
        <button
          role="tab"
          aria-selected={tab === "chain"}
          className={`dd-tab ${tab === "chain" ? "is-on" : ""}`}
          onClick={() => setTab("chain")}
        >
          The Chain
        </button>
      </nav>

      {tab === "today" ? (
        <div className="dd-today">
          <section className="dd-checklist">
            <div className="dd-checklist-head">
              <div>
                <h2 className="dd-section-title">
                  {isToday ? "Today's stack" : longDate(selDate)}
                </h2>
                <p className="dd-section-meta">
                  {selectedDone} of {selectedTotal} honored
                  {!isToday && (
                    <button
                      className="dd-link"
                      onClick={() => setSelected(todayKey)}
                    >
                      back to today
                    </button>
                  )}
                </p>
              </div>
              <button
                className={`dd-ghost ${editing ? "is-on" : ""}`}
                onClick={() => setEditing((e) => !e)}
              >
                {editing ? "Done editing" : "Edit stack"}
              </button>
            </div>

            <ul className="dd-list">
              {habits.map((h, i) => {
                const checked = !!selectedRec?.done?.[h.id];
                const streak = habitStreak(h.id);
                return (
                  <li
                    key={h.id}
                    className={`dd-row ${checked ? "is-done" : ""} ${
                      h.polarity === "resist" ? "is-resist" : ""
                    }`}
                  >
                    {editing ? (
                      <div className="dd-edit-row">
                        <div className="dd-edit-fields">
                          <input
                            className="dd-input dd-input-name"
                            value={h.name}
                            aria-label="Habit name"
                            onChange={(e) =>
                              updateHabit(h.id, { name: e.target.value })
                            }
                          />
                          <input
                            className="dd-input dd-input-detail"
                            value={h.detail}
                            placeholder="optional detail"
                            aria-label="Habit detail"
                            onChange={(e) =>
                              updateHabit(h.id, { detail: e.target.value })
                            }
                          />
                        </div>
                        <div className="dd-edit-controls">
                          <button
                            className="dd-pol"
                            title="Toggle build / resist"
                            onClick={() =>
                              updateHabit(h.id, {
                                polarity:
                                  h.polarity === "build" ? "resist" : "build",
                              })
                            }
                          >
                            {h.polarity === "resist" ? "resist" : "build"}
                          </button>
                          <button
                            className="dd-icon"
                            aria-label="Move up"
                            disabled={i === 0}
                            onClick={() => moveHabit(h.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            className="dd-icon"
                            aria-label="Move down"
                            disabled={i === habits.length - 1}
                            onClick={() => moveHabit(h.id, 1)}
                          >
                            ↓
                          </button>
                          <button
                            className="dd-icon dd-icon-del"
                            aria-label={`Remove ${h.name}`}
                            onClick={() => removeHabit(h.id)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="dd-check-btn"
                        aria-pressed={checked}
                        aria-label={`${checked ? "Unmark" : "Mark"} ${h.name}`}
                        onClick={() => toggleHabit(h.id)}
                      >
                        <span className="dd-check" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14">
                            <path
                              d="M5 12.5l4.5 4.5L19 7"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span className="dd-row-text">
                          <span className="dd-row-name">
                            {h.name}
                            {h.polarity === "resist" && (
                              <span className="dd-tag">resist</span>
                            )}
                          </span>
                          {h.detail && (
                            <span className="dd-row-detail">{h.detail}</span>
                          )}
                        </span>
                        {streak > 0 && (
                          <span
                            className="dd-row-streak"
                            title={`${streak} day streak`}
                          >
                            {streak}
                            <span className="dd-row-streak-u">d</span>
                          </span>
                        )}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            {editing && <AddHabit onAdd={addHabit} />}
          </section>

          <aside className="dd-rail">
            <div className="dd-ring-card">
              <Ring done={selectedDone} total={selectedTotal} />
              <div
                className={`dd-seal ${selectedComplete ? "is-complete" : ""}`}
              >
                {selectedComplete ? (
                  <>
                    <span className="dd-seal-mark">✓</span>
                    <span className="dd-seal-text">The day is complete.</span>
                  </>
                ) : (
                  <span className="dd-seal-text">
                    {selectedTotal - selectedDone} left to honor.
                  </span>
                )}
              </div>
            </div>

            <div className="dd-note-card">
              <label className="dd-note-label" htmlFor="dd-note">
                {isToday ? "How did today go?" : `Note · ${longDate(selDate)}`}
              </label>
              <textarea
                id="dd-note"
                className="dd-note"
                rows={3}
                placeholder="One honest line. Optional."
                value={selectedRec?.note ?? ""}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </aside>
        </div>
      ) : (
        <ChainView
          days={days}
          habits={habits}
          startedAt={startedAt}
          todayKey={todayKey}
          dayRatio={dayRatio}
          dayComplete={dayComplete}
          habitStreak={habitStreak}
          overallStreak={overallStreak}
          stats={stats}
          onPick={(k) => {
            setSelected(k);
            setEditing(false);
            setTab("today");
          }}
        />
      )}
    </div>
  );
}

// ── Add-habit form ────────────────────────────────────────────────────────────

function AddHabit({
  onAdd,
}: {
  onAdd: (name: string, detail: string, polarity: Polarity) => void;
}) {
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [polarity, setPolarity] = useState<Polarity>("build");

  const submit = () => {
    if (!name.trim()) return;
    onAdd(name, detail, polarity);
    setName("");
    setDetail("");
    setPolarity("build");
  };

  return (
    <div className="dd-add">
      <input
        className="dd-input dd-input-name"
        placeholder="New habit"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <input
        className="dd-input dd-input-detail"
        placeholder="detail (optional)"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <button
        className="dd-pol"
        onClick={() => setPolarity((p) => (p === "build" ? "resist" : "build"))}
      >
        {polarity}
      </button>
      <button className="dd-add-btn" onClick={submit} disabled={!name.trim()}>
        Add
      </button>
    </div>
  );
}

// ── Completion ring ───────────────────────────────────────────────────────────

function Ring({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? done / total : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);
  return (
    <div className="dd-ring">
      <svg viewBox="0 0 128 128" width="148" height="148">
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="7"
        />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 64 64)"
          className="dd-ring-arc"
        />
      </svg>
      <div className="dd-ring-center">
        <span className="dd-ring-done">{done}</span>
        <span className="dd-ring-total">/ {total}</span>
      </div>
    </div>
  );
}

// ── The Chain (heatmap + stats) ─────────────────────────────────────────────

const WEEKS = 26;

function ChainView({
  days,
  habits,
  startedAt,
  todayKey,
  dayRatio,
  dayComplete,
  habitStreak,
  overallStreak,
  stats,
  onPick,
}: {
  days: Days;
  habits: Habit[];
  startedAt: string;
  todayKey: string;
  dayRatio: (k: string) => number;
  dayComplete: (k: string) => boolean;
  habitStreak: (id: string) => number;
  overallStreak: number;
  stats: {
    longest: number;
    perfectDays: number;
    activeDays: number;
    totalDays: number;
  };
  onPick: (k: string) => void;
}) {
  const today = fromKey(todayKey);
  // Last column = the week containing today; build back WEEKS columns.
  const endOfWeek = addDays(today, 6 - today.getDay());
  const gridStart = addDays(endOfWeek, -(WEEKS * 7 - 1));

  const columns: Date[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: Date[] = [];
    for (let d = 0; d < 7; d++) col.push(addDays(gridStart, w * 7 + d));
    columns.push(col);
  }

  const monthLabels = columns.map((col, i) => {
    const first = col[0];
    const prev = i > 0 ? columns[i - 1][0] : null;
    if (!prev || first.getMonth() !== prev.getMonth()) {
      return first.getDate() <= 14 ? MONTH[first.getMonth()] : "";
    }
    return "";
  });

  const level = (k: string, future: boolean, before: boolean): string => {
    if (future || before) return "dd-cell is-void";
    const r = dayRatio(k);
    if (r <= 0) return "dd-cell";
    if (dayComplete(k)) return "dd-cell lvl-4";
    if (r >= 0.66) return "dd-cell lvl-3";
    if (r >= 0.33) return "dd-cell lvl-2";
    return "dd-cell lvl-1";
  };

  const start = fromKey(startedAt);

  return (
    <div className="dd-chain">
      <div className="dd-stats">
        <Stat label="Current streak" value={overallStreak} unit="days" lead />
        <Stat label="Longest streak" value={stats.longest} unit="days" />
        <Stat label="Perfect days" value={stats.perfectDays} unit="total" />
        <Stat
          label="Consistency"
          value={
            stats.totalDays > 0
              ? Math.round((stats.perfectDays / stats.totalDays) * 100)
              : 0
          }
          unit="%"
        />
      </div>

      <section className="dd-heatmap-card">
        <div className="dd-heatmap-head">
          <h2 className="dd-section-title">Don't break the chain</h2>
          <div className="dd-legend">
            <span>less</span>
            <span className="dd-cell" />
            <span className="dd-cell lvl-1" />
            <span className="dd-cell lvl-2" />
            <span className="dd-cell lvl-3" />
            <span className="dd-cell lvl-4" />
            <span>more</span>
          </div>
        </div>

        <div className="dd-heatmap-scroll">
          <div className="dd-months">
            {monthLabels.map((m, i) => (
              <span key={i} className="dd-month">
                {m}
              </span>
            ))}
          </div>
          <div className="dd-grid">
            {columns.map((col, i) => (
              <div key={i} className="dd-col">
                {col.map((d) => {
                  const k = toKey(d);
                  const future = d > today;
                  const before = d < start;
                  const interactive = !future && !before;
                  return (
                    <button
                      key={k}
                      className={level(k, future, before)}
                      title={
                        interactive
                          ? `${longDate(d)} — ${dayComplete(k) ? "complete" : `${Math.round(dayRatio(k) * 100)}%`}`
                          : longDate(d)
                      }
                      disabled={!interactive}
                      onClick={() => interactive && onPick(k)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="dd-habit-streaks">
        <h2 className="dd-section-title">Per-habit streaks</h2>
        <ul className="dd-hs-list">
          {habits.map((h) => {
            const streak = habitStreak(h.id);
            const last14: boolean[] = [];
            for (let i = 13; i >= 0; i--) {
              last14.push(!!days[toKey(addDays(today, -i))]?.done?.[h.id]);
            }
            return (
              <li key={h.id} className="dd-hs-row">
                <span className="dd-hs-name">{h.name}</span>
                <span className="dd-hs-dots" aria-hidden>
                  {last14.map((on, i) => (
                    <span
                      key={i}
                      className={`dd-hs-dot ${on ? "is-on" : ""}`}
                    />
                  ))}
                </span>
                <span className={`dd-hs-num ${streak > 0 ? "is-on" : ""}`}>
                  {streak}
                  <span className="dd-hs-u">d</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  lead,
}: {
  label: string;
  value: number;
  unit: string;
  lead?: boolean;
}) {
  return (
    <div className={`dd-stat ${lead ? "is-lead" : ""}`}>
      <span className="dd-stat-num">
        {value}
        <span className="dd-stat-unit">{unit}</span>
      </span>
      <span className="dd-stat-label">{label}</span>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const CSS = `
.dd-root {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  padding: clamp(1.5rem, 3vw, 2.75rem) clamp(1.5rem, 4vw, 3.5rem);
  color: var(--foreground);
  font-family: var(--font-family-sans, 'Manrope', sans-serif);
  letter-spacing: var(--font-family-sans--default-letter-spacing, -0.02em);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  --dd-line: color-mix(in srgb, var(--foreground) 9%, transparent);
  --dd-faint: color-mix(in srgb, var(--foreground) 4%, transparent);
  --dd-weak: var(--text-weaker, var(--muted-foreground));
}

/* Hero */
.dd-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 2rem;
  flex-wrap: wrap;
}
.dd-eyebrow {
  margin: 0 0 0.5rem;
  font-family: var(--font-family-mono, 'IBM Plex Mono', monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--dd-weak);
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.dd-eyebrow-dot {
  width: 3px; height: 3px; border-radius: 50%;
  background: currentColor; opacity: 0.5;
}
.dd-title {
  margin: 0;
  font-family: var(--font-family-display, 'Cormorant Garamond', Georgia, serif);
  font-weight: 300;
  font-size: clamp(2.6rem, 5vw, 3.6rem);
  line-height: 1;
  letter-spacing: -0.04em;
}
.dd-title em { font-style: italic; }
.dd-sub {
  margin: 0.65rem 0 0;
  color: var(--dd-weak);
  font-size: 14px;
  max-width: 52ch;
}
.dd-hero-streak {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1;
}
.dd-streak-num {
  font-family: var(--font-family-display, 'Cormorant Garamond', serif);
  font-weight: 300;
  font-size: clamp(3.4rem, 7vw, 5rem);
  letter-spacing: -0.05em;
  color: var(--accent);
}
.dd-streak-label {
  font-family: var(--font-family-mono, monospace);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--dd-weak);
  margin-top: 0.35rem;
}

/* Tabs */
.dd-tabs {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--dd-line);
  border-radius: var(--radius-full, 999px);
  background: var(--dd-faint);
  align-self: flex-start;
}
.dd-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dd-weak);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 0.45rem 1.15rem;
  border-radius: var(--radius-full, 999px);
  cursor: pointer;
  transition: color 0.18s ease, background 0.18s ease;
}
.dd-tab:hover { color: var(--foreground); }
.dd-tab.is-on {
  background: var(--card);
  color: var(--foreground);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--foreground) 10%, transparent);
}

/* Today layout */
.dd-today {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 860px) {
  .dd-today { grid-template-columns: 1fr; }
}

.dd-checklist {
  border: 1px solid var(--dd-line);
  border-radius: var(--radius-2xl, 14px);
  background: var(--card);
  padding: 1.4rem 1.5rem 1.5rem;
}
.dd-checklist-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.dd-section-title {
  margin: 0;
  font-family: var(--font-family-display, serif);
  font-weight: 400;
  font-size: 1.5rem;
  letter-spacing: -0.02em;
}
.dd-section-meta {
  margin: 0.3rem 0 0;
  font-family: var(--font-family-mono, monospace);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--dd-weak);
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.dd-link {
  appearance: none; border: none; background: none;
  color: var(--accent); font: inherit; cursor: pointer;
  text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px;
}
.dd-link:hover { text-decoration: underline; }

.dd-ghost {
  appearance: none;
  border: 1px solid var(--dd-line);
  background: transparent;
  color: var(--dd-weak);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 0.4rem 0.85rem;
  border-radius: var(--radius-full, 999px);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.18s ease, border-color 0.18s ease;
}
.dd-ghost:hover { color: var(--foreground); border-color: var(--foreground); }
.dd-ghost.is-on { color: var(--accent); border-color: var(--accent); }

.dd-list { list-style: none; margin: 0; padding: 0; }
.dd-row { border-top: 1px solid var(--dd-line); }
.dd-row:first-child { border-top: none; }

.dd-check-btn {
  width: 100%;
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.7rem 0.5rem;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
  transition: background 0.15s ease;
}
.dd-check-btn:hover { background: var(--dd-faint); }
.dd-check-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.dd-check {
  flex: none;
  width: 22px; height: 22px;
  border-radius: 7px;
  border: 1.5px solid color-mix(in srgb, var(--foreground) 28%, transparent);
  display: grid;
  place-items: center;
  color: var(--accent-foreground, #fff);
  transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}
.dd-check svg { opacity: 0; transform: scale(0.5); transition: opacity 0.18s ease, transform 0.18s ease; }
.dd-row.is-done .dd-check {
  background: var(--accent);
  border-color: var(--accent);
}
.dd-row.is-done .dd-check svg { opacity: 1; transform: scale(1); }

.dd-row-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; flex: 1; }
.dd-row-name {
  font-size: 15px; font-weight: 600;
  display: flex; align-items: center; gap: 0.5rem;
  transition: color 0.18s ease;
}
.dd-row.is-done .dd-row-name { color: var(--dd-weak); }
.dd-row-detail { font-size: 12px; color: var(--dd-weak); }
.dd-tag {
  font-family: var(--font-family-mono, monospace);
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--dd-weak);
  border: 1px solid var(--dd-line);
  border-radius: 999px; padding: 1px 6px;
}
.dd-row-streak {
  flex: none;
  font-family: var(--font-family-mono, monospace);
  font-size: 14px; font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  display: flex; align-items: baseline; gap: 1px;
}
.dd-row-streak-u { font-size: 9px; opacity: 0.7; }

/* Edit mode */
.dd-edit-row {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.25rem;
}
.dd-edit-fields { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; }
.dd-edit-controls { display: flex; align-items: center; gap: 0.3rem; flex: none; }
.dd-input {
  appearance: none;
  border: 1px solid var(--dd-line);
  background: var(--background);
  color: var(--foreground);
  font: inherit;
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
}
.dd-input:focus-visible { outline: none; border-color: var(--accent); }
.dd-input-name { font-weight: 600; font-size: 14px; }
.dd-input-detail { font-size: 12px; color: var(--dd-weak); }
.dd-pol {
  appearance: none;
  border: 1px solid var(--dd-line);
  background: transparent;
  color: var(--dd-weak);
  font-family: var(--font-family-mono, monospace);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  padding: 0.35rem 0.55rem; border-radius: 999px; cursor: pointer;
}
.dd-pol:hover { color: var(--foreground); }
.dd-icon {
  appearance: none;
  border: 1px solid var(--dd-line);
  background: transparent;
  color: var(--dd-weak);
  width: 28px; height: 28px; border-radius: 8px;
  cursor: pointer; font-size: 14px;
  display: grid; place-items: center;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.dd-icon:hover:not(:disabled) { color: var(--foreground); border-color: var(--foreground); }
.dd-icon:disabled { opacity: 0.3; cursor: default; }
.dd-icon-del:hover { color: #d9534f; border-color: #d9534f; }

.dd-add {
  display: flex; gap: 0.5rem; align-items: center;
  margin-top: 1rem; padding-top: 1rem;
  border-top: 1px dashed var(--dd-line);
  flex-wrap: wrap;
}
.dd-add .dd-input-name { flex: 1; min-width: 140px; }
.dd-add .dd-input-detail { flex: 1; min-width: 120px; }
.dd-add-btn {
  appearance: none;
  border: none;
  background: var(--accent);
  color: var(--accent-foreground, #fff);
  font: inherit; font-weight: 600; font-size: 13px;
  padding: 0.45rem 1.1rem; border-radius: 999px; cursor: pointer;
}
.dd-add-btn:disabled { opacity: 0.4; cursor: default; }

/* Rail */
.dd-rail { display: flex; flex-direction: column; gap: 1rem; }
.dd-ring-card, .dd-note-card {
  border: 1px solid var(--dd-line);
  border-radius: var(--radius-2xl, 14px);
  background: var(--card);
  padding: 1.5rem;
}
.dd-ring-card { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
.dd-ring { position: relative; width: 148px; height: 148px; }
.dd-ring-arc { transition: stroke-dashoffset 0.5s cubic-bezier(0.4,0,0.2,1); }
.dd-ring-center {
  position: absolute; inset: 0;
  display: flex; align-items: baseline; justify-content: center; gap: 0.2rem;
}
.dd-ring-done {
  font-family: var(--font-family-display, serif);
  font-weight: 300; font-size: 3rem; line-height: 1; letter-spacing: -0.04em;
}
.dd-ring-total {
  font-family: var(--font-family-mono, monospace);
  font-size: 13px; color: var(--dd-weak);
}
.dd-seal { text-align: center; min-height: 1.4rem; }
.dd-seal-text {
  font-family: var(--font-family-display, serif);
  font-size: 1.05rem; font-style: italic; color: var(--dd-weak);
}
.dd-seal.is-complete .dd-seal-text { color: var(--foreground); font-style: italic; }
.dd-seal-mark {
  display: inline-grid; place-items: center;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--accent); color: var(--accent-foreground, #fff);
  font-size: 11px; margin-right: 0.5rem; vertical-align: middle;
}

.dd-note-label {
  display: block;
  font-family: var(--font-family-mono, monospace);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--dd-weak); margin-bottom: 0.6rem;
}
.dd-note {
  width: 100%; box-sizing: border-box;
  appearance: none; resize: vertical;
  border: 1px solid var(--dd-line);
  background: var(--background);
  color: var(--foreground);
  font: inherit; font-size: 14px; line-height: 1.5;
  border-radius: 10px; padding: 0.65rem 0.75rem;
}
.dd-note:focus-visible { outline: none; border-color: var(--accent); }
.dd-note::placeholder { color: var(--dd-weak); }

/* Chain */
.dd-chain { display: flex; flex-direction: column; gap: 1.25rem; }
.dd-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}
@media (max-width: 720px) { .dd-stats { grid-template-columns: repeat(2, 1fr); } }
.dd-stat {
  border: 1px solid var(--dd-line);
  border-radius: var(--radius-2xl, 14px);
  background: var(--card);
  padding: 1.1rem 1.25rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.dd-stat.is-lead { border-color: color-mix(in srgb, var(--accent) 45%, var(--dd-line)); }
.dd-stat-num {
  font-family: var(--font-family-display, serif);
  font-weight: 300; font-size: 2.6rem; line-height: 1; letter-spacing: -0.04em;
  display: flex; align-items: baseline; gap: 0.3rem;
}
.dd-stat.is-lead .dd-stat-num { color: var(--accent); }
.dd-stat-unit {
  font-family: var(--font-family-mono, monospace);
  font-size: 12px; color: var(--dd-weak); letter-spacing: 0;
}
.dd-stat-label {
  font-family: var(--font-family-mono, monospace);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--dd-weak);
}

.dd-heatmap-card, .dd-habit-streaks {
  border: 1px solid var(--dd-line);
  border-radius: var(--radius-2xl, 14px);
  background: var(--card);
  padding: 1.4rem 1.5rem;
}
.dd-heatmap-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap;
}
.dd-legend {
  display: flex; align-items: center; gap: 0.3rem;
  font-family: var(--font-family-mono, monospace);
  font-size: 10px; color: var(--dd-weak); text-transform: uppercase; letter-spacing: 0.08em;
}
.dd-heatmap-scroll { overflow-x: auto; padding-bottom: 0.25rem; }
.dd-months {
  display: flex; gap: 3px; margin-bottom: 4px; padding-left: 0;
}
.dd-month {
  width: 13px; flex: none;
  font-family: var(--font-family-mono, monospace);
  font-size: 9px; color: var(--dd-weak);
  white-space: nowrap; overflow: visible;
}
.dd-grid { display: flex; gap: 3px; }
.dd-col { display: flex; flex-direction: column; gap: 3px; }
.dd-cell {
  width: 13px; height: 13px; flex: none;
  border-radius: 3px;
  border: 1px solid var(--dd-line);
  background: transparent;
  padding: 0; cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.dd-cell:not(:disabled):hover {
  transform: scale(1.18);
  box-shadow: 0 0 0 1px var(--accent);
}
.dd-cell:disabled { cursor: default; }
.dd-cell.is-void { border-color: transparent; background: transparent; cursor: default; }
.dd-cell.lvl-1 { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: transparent; }
.dd-cell.lvl-2 { background: color-mix(in srgb, var(--accent) 45%, transparent); border-color: transparent; }
.dd-cell.lvl-3 { background: color-mix(in srgb, var(--accent) 70%, transparent); border-color: transparent; }
.dd-cell.lvl-4 { background: var(--accent); border-color: transparent; }
.dd-legend .dd-cell { cursor: default; }

.dd-hs-list { list-style: none; margin: 0.75rem 0 0; padding: 0; }
.dd-hs-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.55rem 0; border-top: 1px solid var(--dd-line);
}
.dd-hs-row:first-child { border-top: none; }
.dd-hs-name { flex: 1; font-size: 14px; font-weight: 500; min-width: 0; }
.dd-hs-dots { display: flex; gap: 3px; flex: none; }
.dd-hs-dot {
  width: 8px; height: 8px; border-radius: 2px;
  background: var(--dd-line);
}
.dd-hs-dot.is-on { background: var(--accent); }
.dd-hs-num {
  flex: none; width: 3.2rem; text-align: right;
  font-family: var(--font-family-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 15px; color: var(--dd-weak);
  display: flex; align-items: baseline; justify-content: flex-end; gap: 1px;
}
.dd-hs-num.is-on { color: var(--accent); }
.dd-hs-u { font-size: 9px; opacity: 0.7; }

@media (prefers-reduced-motion: reduce) {
  .dd-ring-arc, .dd-check, .dd-check svg, .dd-cell, .dd-check-btn,
  .dd-tab, .dd-ghost, .dd-icon { transition: none; }
}
`;
