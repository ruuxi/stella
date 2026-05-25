import { Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Search } from "lucide-react";
import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import {
  getSnapshot,
  subscribe,
  type UserApp,
} from "@/app/_user/user-apps-registry";
import "./apps.css";

type SortOption = "recent" | "name";

const SORT_LABELS: Record<SortOption, string> = {
  recent: "Most recent",
  name: "Name",
};

const RELATIVE_UNITS: ReadonlyArray<{ ms: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { ms: 60 * 1000, unit: "second" },
  { ms: 60 * 60 * 1000, unit: "minute" },
  { ms: 24 * 60 * 60 * 1000, unit: "hour" },
  { ms: 7 * 24 * 60 * 60 * 1000, unit: "day" },
  { ms: 30 * 24 * 60 * 60 * 1000, unit: "week" },
  { ms: 365 * 24 * 60 * 60 * 1000, unit: "month" },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function formatCreatedAt(iso: string): string {
  const created = new Date(iso).getTime();
  if (!Number.isFinite(created)) return "";
  const diff = created - Date.now();
  const abs = Math.abs(diff);
  for (let i = 0; i < RELATIVE_UNITS.length - 1; i++) {
    const current = RELATIVE_UNITS[i]!;
    const next = RELATIVE_UNITS[i + 1]!;
    if (abs < next.ms) {
      return relativeTimeFormatter.format(Math.round(diff / current.ms), current.unit);
    }
  }
  const last = RELATIVE_UNITS[RELATIVE_UNITS.length - 1]!;
  return relativeTimeFormatter.format(Math.round(diff / last.ms), last.unit);
}

function useUserApps(): readonly UserApp[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_PROMPTS: ReadonlyArray<string> = [
  "a kanban board for my week",
  "a notes app that groups by topic",
  "a tiny synth with a few keys",
  "a recipe box for what I cook",
];

export function AppsApp() {
  const apps = useUserApps();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("recent");
  const deferredQuery = useDeferredValue(query);

  const handleCreateApp = useCallback(() => {
    void navigate({ to: "/chat" }).then(() => {
      dispatchShowHome();
    });
  }, [navigate]);

  const visible = useMemo(() => {
    const trimmed = deferredQuery.trim().toLowerCase();
    const filtered = trimmed
      ? apps.filter(
          (app) =>
            app.meta.label.toLowerCase().includes(trimmed) ||
            app.slug.toLowerCase().includes(trimmed),
        )
      : apps.slice();
    if (sort === "name") {
      filtered.sort((a, b) => a.meta.label.localeCompare(b.meta.label));
    } else {
      filtered.sort((a, b) => {
        const at = Date.parse(a.meta.createdAt);
        const bt = Date.parse(b.meta.createdAt);
        const av = Number.isFinite(at) ? at : 0;
        const bv = Number.isFinite(bt) ? bt : 0;
        return bv - av;
      });
    }
    return filtered;
  }, [apps, deferredQuery, sort]);

  const hasApps = apps.length > 0;

  return (
    <main className="apps-screen">
      <header className="apps-screen__hero">
        <h1 className="apps-screen__title">
          <em>Your</em> apps
        </h1>
      </header>

      {hasApps ? (
        <>
          <div className="apps-screen__toolbar">
            <label className="apps-screen__search">
              <Search
                size={14}
                className="apps-screen__search-icon"
                aria-hidden
              />
              <input
                type="search"
                placeholder="Search apps"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="apps-screen__search-input"
              />
            </label>
            <div className="apps-screen__sort">
              <span className="apps-screen__sort-label">Sort</span>
              <select
                className="apps-screen__sort-select"
                value={sort}
                onChange={(event) =>
                  setSort(event.currentTarget.value as SortOption)
                }
                aria-label="Sort"
              >
                {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
                  <option key={option} value={option}>
                    {SORT_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="apps-screen__cta apps-screen__cta--primary"
              onClick={handleCreateApp}
            >
              Create an app
            </button>
          </div>

          {visible.length === 0 ? (
            <div className="apps-screen__no-match">
              No apps match <span className="apps-screen__no-match-query">"{deferredQuery}"</span>.
            </div>
          ) : (
            <ul className="apps-screen__grid">
              {visible.map((app) => (
                <li key={app.slug} className="apps-card">
                  <Link
                    to="/apps/$slug"
                    params={{ slug: app.slug }}
                    className="apps-card__link"
                  >
                    <span className="apps-card__label">{app.meta.label}</span>
                    <span className="apps-card__meta">
                      {formatCreatedAt(app.meta.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <section className="apps-screen__empty" aria-labelledby="apps-empty-title">
          <h2 id="apps-empty-title" className="apps-screen__empty-title">
            Nothing here yet.
          </h2>
          <p className="apps-screen__empty-body">
            Stella can build you anything that lives inside Stella — a
            kanban, a notes app, a small game, a synth, a dashboard. Made
            apps will show up here.
          </p>
          <button
            type="button"
            className="apps-screen__cta apps-screen__cta--primary apps-screen__cta--lg"
            onClick={handleCreateApp}
          >
            Ask Stella to create an app
          </button>
          <ul className="apps-screen__suggestions" aria-label="For inspiration">
            {EMPTY_PROMPTS.map((prompt) => (
              <li key={prompt} className="apps-screen__suggestion">
                {prompt}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
