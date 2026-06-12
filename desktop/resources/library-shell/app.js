/**
 * Library shell — renders the canvas library from /manifest.json.
 *
 * The shell is pure app-owned chrome: the model writes pages and manifest
 * entries via the html tool; this script only reads the manifest and turns
 * it into a browsable home (search, recency groups) plus a page view that
 * hosts each artifact in a sandboxed nested iframe.
 *
 * Host integration (the desktop renderer that embeds this document):
 *   parent -> shell : stella:library-refresh   (manifest changed; refetch)
 *   parent -> shell : stella:library-open      ({ slug }; navigate to page)
 *   parent -> shell : stella:canvas-selection-clear (forward to artifact)
 *   shell  -> parent: stella:library-ready     (first render done)
 *   artifact -> shell -> parent: stella:canvas-selection / canvas-compose
 *     (selection rects are offset by the nested iframe position so the
 *      host's Ask Stella chip math keeps working unchanged)
 */

(() => {
  "use strict";

  const app = document.getElementById("app");

  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }

  /** @type {{slug: string, title: string, description?: string, tags?: string[], createdAt: number, updatedAt: number}[]} */
  let entries = [];
  let query = "";
  let readySent = false;
  // updatedAt per slug from the previous render; drives the "fresh" flash.
  let lastSeen = new Map();
  let artifactFrame = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const relativeTime = (ms) => {
    const delta = Date.now() - ms;
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + "h ago";
    const days = Math.round(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return days + "d ago";
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  const greetingForNow = () => {
    const hour = new Date().getHours();
    if (hour < 5) return "Up late";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  };

  const startOfToday = () => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };

  const matchesQuery = (entry) => {
    if (!query) return true;
    const haystack = [entry.title, entry.description || ""]
      .concat(entry.tags || [])
      .join(" ")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((term) => haystack.includes(term));
  };

  const currentSlug = () => {
    const match = /^#\/a\/([a-z0-9][a-z0-9-]{0,63})$/.exec(location.hash);
    return match ? match[1] : null;
  };

  const openPage = (slug) => {
    location.hash = "#/a/" + slug;
  };

  const fetchManifest = async () => {
    try {
      const response = await fetch("/manifest.json", { cache: "no-store" });
      const manifest = await response.json();
      entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    } catch {
      entries = [];
    }
  };

  /* ---------- Home ---------- */

  const cardFor = (entry) => {
    const fresh =
      lastSeen.size > 0 &&
      (lastSeen.get(entry.slug) === undefined ||
        lastSeen.get(entry.slug) < entry.updatedAt);
    const card = el("button", "card" + (fresh ? " card--fresh" : ""));
    card.type = "button";
    card.appendChild(el("h3", "card__title", entry.title));
    if (entry.description) {
      card.appendChild(el("p", "card__description", entry.description));
    }
    const meta = el("div", "card__meta");
    const time = el("span", "card__time");
    time.textContent =
      (entry.updatedAt > entry.createdAt ? "updated " : "") +
      relativeTime(entry.updatedAt);
    meta.appendChild(time);
    for (const tag of (entry.tags || []).slice(0, 3)) {
      meta.appendChild(el("span", "tag", tag));
    }
    card.appendChild(meta);
    card.addEventListener("click", () => openPage(entry.slug));
    return card;
  };

  const rowFor = (entry) => {
    const row = el("button", "row");
    row.type = "button";
    row.appendChild(el("span", "row__title", entry.title));
    row.appendChild(el("span", "row__description", entry.description || ""));
    row.appendChild(el("span", "row__time", relativeTime(entry.updatedAt)));
    row.addEventListener("click", () => openPage(entry.slug));
    return row;
  };

  const groupSection = (label, children) => {
    const group = el("section", "group");
    group.appendChild(el("h2", "group__label", label));
    for (const child of children) group.appendChild(child);
    return group;
  };

  const renderHome = () => {
    artifactFrame = null;
    const home = el("div", "home");

    const header = el("div", "home__header");
    const heading = el("div");
    heading.appendChild(el("h1", "home__greeting", greetingForNow()));
    const todayStart = startOfToday();
    const updatedToday = entries.filter(
      (entry) => entry.updatedAt >= todayStart,
    ).length;
    heading.appendChild(
      el(
        "p",
        "home__summary",
        entries.length === 0
          ? "Nothing here yet"
          : entries.length +
              (entries.length === 1 ? " page" : " pages") +
              (updatedToday > 0 ? " · " + updatedToday + " updated today" : ""),
      ),
    );
    header.appendChild(heading);

    const search = el("input", "home__search");
    search.type = "search";
    search.placeholder = "Search your pages";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value.trim();
      renderHomeBody(home);
    });
    header.appendChild(search);
    home.appendChild(header);

    renderHomeBody(home);

    app.replaceChildren(home);
  };

  const renderHomeBody = (home) => {
    for (const section of home.querySelectorAll(".group, .empty")) {
      section.remove();
    }

    const visible = entries.filter(matchesQuery);
    if (visible.length === 0) {
      const empty = el("div", "empty");
      empty.appendChild(
        el(
          "h2",
          "empty__title",
          query ? "No pages match" : "Pages land here",
        ),
      );
      empty.appendChild(
        el(
          "p",
          "empty__hint",
          query
            ? "Try a different search."
            : "Plans, reports, comparisons, and other pages Stella makes for you collect in this library.",
        ),
      );
      home.appendChild(empty);
      return;
    }

    const sorted = visible.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const todayStart = startOfToday();
    const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
    const today = sorted.filter((entry) => entry.updatedAt >= todayStart);
    const thisWeek = sorted.filter(
      (entry) => entry.updatedAt < todayStart && entry.updatedAt >= weekStart,
    );
    const earlier = sorted.filter((entry) => entry.updatedAt < weekStart);

    if (today.length > 0) {
      const cards = el("div", "cards");
      for (const entry of today) cards.appendChild(cardFor(entry));
      home.appendChild(groupSection("Today", [cards]));
    }
    if (thisWeek.length > 0) {
      const cards = el("div", "cards");
      for (const entry of thisWeek) cards.appendChild(cardFor(entry));
      home.appendChild(groupSection("This week", [cards]));
    }
    if (earlier.length > 0) {
      const rows = el("div", "rows");
      for (const entry of earlier) rows.appendChild(rowFor(entry));
      home.appendChild(groupSection("Earlier", [rows]));
    }
  };

  /* ---------- Page view ---------- */

  const renderPage = (slug) => {
    const entry = entries.find((candidate) => candidate.slug === slug);
    const page = el("div", "page");

    const bar = el("div", "page__bar");
    const back = el("button", "page__back", "← Library");
    back.type = "button";
    back.addEventListener("click", () => {
      location.hash = "#/";
    });
    bar.appendChild(back);
    bar.appendChild(el("span", "page__title", entry ? entry.title : slug));
    if (entry) {
      bar.appendChild(
        el(
          "span",
          "page__time",
          (entry.updatedAt > entry.createdAt ? "updated " : "") +
            relativeTime(entry.updatedAt),
        ),
      );
    }
    page.appendChild(bar);

    const frame = el("iframe", "page__frame");
    frame.src = "/a/" + slug;
    frame.title = entry ? entry.title : slug;
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-modals allow-forms",
    );
    frame.setAttribute("referrerpolicy", "no-referrer");
    page.appendChild(frame);
    artifactFrame = frame;

    app.replaceChildren(page);
  };

  /* ---------- Render + routing ---------- */

  const render = () => {
    const slug = currentSlug();
    if (slug) renderPage(slug);
    else renderHome();
    const seen = new Map();
    for (const entry of entries) seen.set(entry.slug, entry.updatedAt);
    lastSeen = seen;
    if (!readySent) {
      readySent = true;
      window.parent.postMessage({ type: "stella:library-ready" }, "*");
    }
  };

  window.addEventListener("hashchange", render);

  /* ---------- Host + artifact messaging ---------- */

  const offsetSelectionRect = (data) => {
    if (!artifactFrame || !data.rect || typeof data.rect !== "object") {
      return data;
    }
    const frameRect = artifactFrame.getBoundingClientRect();
    return Object.assign({}, data, {
      rect: {
        left: (data.rect.left || 0) + frameRect.left,
        top: (data.rect.top || 0) + frameRect.top,
        width: data.rect.width || 0,
        height: data.rect.height || 0,
      },
    });
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return;
    }

    if (artifactFrame && event.source === artifactFrame.contentWindow) {
      if (data.type === "stella:canvas-selection") {
        window.parent.postMessage(offsetSelectionRect(data), "*");
      } else if (data.type === "stella:canvas-compose") {
        window.parent.postMessage(data, "*");
      }
      return;
    }

    if (event.source === window.parent) {
      if (data.type === "stella:library-refresh") {
        void fetchManifest().then(render);
      } else if (
        data.type === "stella:library-open" &&
        typeof data.slug === "string"
      ) {
        void fetchManifest().then(() => {
          if (currentSlug() === data.slug) render();
          else openPage(data.slug);
        });
      } else if (data.type === "stella:canvas-selection-clear") {
        artifactFrame?.contentWindow?.postMessage(data, "*");
      }
    }
  });

  void fetchManifest().then(render);
})();
