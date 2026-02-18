import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useQuery, useMutation } from "convex/react";
import StoreView from "./StoreView";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => undefined),
  useMutation: vi.fn(() => vi.fn()),
}));

vi.mock("@/convex/api", () => ({
  api: {
    data: {
      store_packages: {
        list: "store_packages.list",
        search: "store_packages.search",
        getInstalled: "store_packages.getInstalled",
        getByPackageId: "store_packages.getByPackageId",
        install: "store_packages.install",
        uninstall: "store_packages.uninstall",
      },
    },
  },
}));

const mockSetView = vi.fn();
vi.mock("@/app/state/ui-state", () => ({
  useUiState: () => ({ state: { view: "store" }, setView: mockSetView }),
}));

vi.mock("@/theme/themes", () => ({
  registerTheme: vi.fn(),
  unregisterTheme: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makePkg(overrides: Partial<{
  _id: string;
  packageId: string;
  name: string;
  author: string;
  description: string;
  type: string;
  version: string;
  tags: string[];
  downloads: number;
  rating: number;
  icon: string;
  readme: string;
  modPayload: unknown;
  implementation: string;
}> = {}) {
  return {
    _id: overrides._id ?? "id-1",
    packageId: overrides.packageId ?? "pkg-1",
    name: overrides.name ?? "Test Package",
    author: overrides.author ?? "testauthor",
    description: overrides.description ?? "A test package",
    type: overrides.type ?? "skill",
    version: overrides.version ?? "1.0.0",
    tags: overrides.tags ?? ["test"],
    downloads: overrides.downloads ?? 10,
    rating: overrides.rating,
    icon: overrides.icon,
    readme: overrides.readme,
    modPayload: overrides.modPayload,
    implementation: overrides.implementation,
  };
}

const samplePackages = [
  makePkg({ _id: "id-1", packageId: "pkg-1", name: "Alpha Skill", author: "alice", type: "skill", downloads: 100 }),
  makePkg({ _id: "id-2", packageId: "pkg-2", name: "Beta Canvas", author: "bob", type: "canvas", downloads: 50 }),
  makePkg({ _id: "id-3", packageId: "pkg-3", name: "Gamma Theme", author: "carol", type: "theme", downloads: 25 }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof StoreView>[0]> = {}) {
  return {
    onBack: vi.fn(),
    onComposePrompt: vi.fn(),
    ...overrides,
  };
}

function mockUseMutation(
  impl: (mutationPath: unknown) => unknown,
) {
  vi.mocked(useMutation).mockImplementation(impl as any);
}

/** Click a header tab (Browse, Installed, Updates) by targeting .store-header-tab buttons */
function clickTab(tabText: string) {
  const tabs = document.querySelectorAll(".store-header-tab");
  const tab = Array.from(tabs).find((t) => t.textContent === tabText) as HTMLElement;
  if (!tab) throw new Error(`Tab "${tabText}" not found`);
  fireEvent.click(tab);
}

/**
 * Configure useQuery mock to return different values based on the query key.
 */
function setupUseQuery(opts: {
  browsePackages?: unknown;
  searchResults?: unknown;
  installed?: unknown;
  selectedPkg?: unknown;
  allPackages?: unknown;
} = {}) {
  vi.mocked(useQuery).mockImplementation((queryPath: unknown, args?: unknown) => {
    const path = queryPath as string;
    if (path === "store_packages.list") {
      if (args === "skip") return undefined;
      const argObj = args as { type?: string } | undefined;
      if (argObj && argObj.type === undefined) {
        return opts.allPackages ?? opts.browsePackages ?? undefined;
      }
      return opts.browsePackages ?? undefined;
    }
    if (path === "store_packages.search") {
      if (args === "skip") return undefined;
      return opts.searchResults ?? undefined;
    }
    if (path === "store_packages.getInstalled") {
      return opts.installed ?? undefined;
    }
    if (path === "store_packages.getByPackageId") {
      if (args === "skip") return undefined;
      return opts.selectedPkg ?? undefined;
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests: Pure functions & constants
// ---------------------------------------------------------------------------

describe("StoreView pure functions and constants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getAuthorColor returns consistent colors for the same name", () => {
    // Need a featured (highest downloads) and a card (lower downloads) to see cards
    const feat = makePkg({ packageId: "feat", author: "alice", downloads: 99 });
    const card = makePkg({ packageId: "card", author: "alice", downloads: 5 });
    setupUseQuery({
      browsePackages: [feat, card],
      allPackages: [feat, card],
      installed: [],
    });

    const { rerender } = render(<StoreView {...defaultProps()} />);
    const avatar1 = document.querySelector(".store-card .store-author-avatar") as HTMLElement;
    const bg1 = avatar1?.style.background;
    expect(bg1).toBeTruthy();

    rerender(<StoreView {...defaultProps()} />);
    const avatar2 = document.querySelector(".store-card .store-author-avatar") as HTMLElement;
    expect(avatar2?.style.background).toBe(bg1);
  });

  it("getAuthorColor returns valid colors", () => {
    const feat = makePkg({ packageId: "feat", author: "featured", downloads: 99 });
    const card1 = makePkg({ packageId: "p1", author: "alice", downloads: 5 });
    const card2 = makePkg({ packageId: "p2", author: "zephyr", downloads: 3 });
    setupUseQuery({
      browsePackages: [feat, card1, card2],
      allPackages: [feat, card1, card2],
      installed: [],
    });

    render(<StoreView {...defaultProps()} />);
    const avatars = document.querySelectorAll(".store-card .store-author-avatar") as NodeListOf<HTMLElement>;
    expect(avatars.length).toBe(2);
    // jsdom converts hex to rgb(), so just check color values are present
    expect(avatars[0].style.background).toMatch(/rgb\(\d+, \d+, \d+\)/);
    expect(avatars[1].style.background).toMatch(/rgb\(\d+, \d+, \d+\)/);
  });

  it("TYPE_GRADIENTS are applied to package cards based on type", () => {
    const feat = makePkg({ packageId: "feat", type: "mod", downloads: 99 });
    const skillPkg = makePkg({ packageId: "p1", type: "skill", downloads: 5 });
    const canvasPkg = makePkg({ packageId: "p2", type: "canvas", downloads: 3 });
    setupUseQuery({
      browsePackages: [feat, skillPkg, canvasPkg],
      allPackages: [feat, skillPkg, canvasPkg],
      installed: [],
    });

    render(<StoreView {...defaultProps()} />);
    const cards = document.querySelectorAll(".store-card") as NodeListOf<HTMLElement>;
    expect(cards.length).toBe(2);
    // jsdom converts hex to rgb(); skill gradient starts with #ff6b35 = rgb(255, 107, 53)
    expect(cards[0].style.background).toContain("rgb(255, 107, 53)");
    // Canvas gradient starts with #667eea = rgb(102, 126, 234)
    expect(cards[1].style.background).toContain("rgb(102, 126, 234)");
  });
});

// ---------------------------------------------------------------------------
// Tests: StoreHeader
// ---------------------------------------------------------------------------

describe("StoreHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupUseQuery({ browsePackages: [], allPackages: [], installed: [] });
  });

  it("renders Browse, Installed, and Updates tabs", () => {
    render(<StoreView {...defaultProps()} />);
    expect(screen.getByText("Browse")).toBeTruthy();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("Updates")).toBeTruthy();
  });

  it("shows Browse tab as active by default", () => {
    render(<StoreView {...defaultProps()} />);
    const browseTab = screen.getByText("Browse");
    expect(browseTab.className).toContain("store-header-tab--active");

    const installedTab = screen.getByText("Installed");
    expect(installedTab.className).not.toContain("store-header-tab--active");

    const updatesTab = screen.getByText("Updates");
    expect(updatesTab.className).not.toContain("store-header-tab--active");
  });

  it("renders the search input with placeholder", () => {
    render(<StoreView {...defaultProps()} />);
    expect(screen.getByPlaceholderText("Search packages...")).toBeTruthy();
  });

  it("switches to Installed tab on click", () => {
    render(<StoreView {...defaultProps()} />);
    clickTab("Installed");

    const tabs = document.querySelectorAll(".store-header-tab");
    const installedTab = Array.from(tabs).find((t) => t.textContent === "Installed");
    expect(installedTab?.className).toContain("store-header-tab--active");
  });

  it("switches to Updates tab on click", () => {
    render(<StoreView {...defaultProps()} />);
    clickTab("Updates");

    const tabs = document.querySelectorAll(".store-header-tab");
    const updatesTab = Array.from(tabs).find((t) => t.textContent === "Updates");
    expect(updatesTab?.className).toContain("store-header-tab--active");
  });

  it("allows switching back to Browse from another tab", () => {
    render(<StoreView {...defaultProps()} />);
    clickTab("Installed");
    clickTab("Browse");

    const tabs = document.querySelectorAll(".store-header-tab");
    const browseTab = Array.from(tabs).find((t) => t.textContent === "Browse");
    const installedTab = Array.from(tabs).find((t) => t.textContent === "Installed");
    expect(browseTab?.className).toContain("store-header-tab--active");
    expect(installedTab?.className).not.toContain("store-header-tab--active");
  });

  it("updates search input value when typing", () => {
    render(<StoreView {...defaultProps()} />);
    const input = screen.getByPlaceholderText("Search packages...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    expect(input.value).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Tests: Browse page
// ---------------------------------------------------------------------------

describe("Browse page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state when packages are undefined", () => {
    setupUseQuery({ browsePackages: undefined, allPackages: undefined, installed: [] });
    render(<StoreView {...defaultProps()} />);
    expect(screen.getByText("Loading packages...")).toBeTruthy();
  });

  it("shows empty state when packages is empty array", () => {
    setupUseQuery({ browsePackages: [], allPackages: [], installed: [] });
    render(<StoreView {...defaultProps()} />);
    expect(screen.getByText("No packages found")).toBeTruthy();
  });

  it("renders package cards in grid when packages exist", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    // Featured hero gets the top downloads package (Alpha Skill, 100 downloads)
    // The other two should appear as cards
    expect(screen.getByText("Beta Canvas")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders FeaturedHero for the most downloaded package", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const heroTitle = document.querySelector(".store-hero-title");
    expect(heroTitle?.textContent).toBe("Alpha Skill");
  });

  it("excludes featured package from the grid", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const cardTitles = document.querySelectorAll(".store-card-title");
    const cardNames = Array.from(cardTitles).map((el) => el.textContent);
    expect(cardNames).not.toContain("Alpha Skill");
    expect(cardNames).toContain("Beta Canvas");
    expect(cardNames).toContain("Gamma Theme");
  });

  it("shows filter bar when a category is selected", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const skillsCat = screen.getByText("Skills");
    fireEvent.click(skillsCat);

    expect(screen.getByText("Show all")).toBeTruthy();
  });

  it("clears category filter when 'Show all' is clicked", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    fireEvent.click(screen.getByText("Skills"));
    expect(screen.getByText("Show all")).toBeTruthy();

    fireEvent.click(screen.getByText("Show all"));
    expect(screen.queryByText("Show all")).toBeNull();
  });

  it("triggers search when typing in search input", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
      searchResults: [makePkg({ packageId: "pkg-search", name: "Search Result" })],
    });
    render(<StoreView {...defaultProps()} />);

    const input = screen.getByPlaceholderText("Search packages...");
    fireEvent.change(input, { target: { value: "search" } });

    expect(vi.mocked(useQuery)).toHaveBeenCalled();
  });

  it("does not show featured hero when search query is active", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
      searchResults: [makePkg({ packageId: "pkg-search", name: "Search Match" })],
    });
    render(<StoreView {...defaultProps()} />);

    const input = screen.getByPlaceholderText("Search packages...");
    fireEvent.change(input, { target: { value: "search" } });

    expect(document.querySelector(".store-hero")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: FeaturedHero
// ---------------------------------------------------------------------------

describe("FeaturedHero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays package stats (installed count, updates count)", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
        { packageId: "pkg-2", installedVersion: "0.9.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    const statValues = document.querySelectorAll(".store-hero-stat-val");
    const statLabels = document.querySelectorAll(".store-hero-stat-lbl");

    const stats: Record<string, string> = {};
    statLabels.forEach((lbl, i) => {
      stats[lbl.textContent ?? ""] = statValues[i]?.textContent ?? "";
    });

    expect(stats["Installed"]).toBe("2");
  });

  it("displays category buttons (Mods, Skills, Mini-apps, Themes)", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    expect(screen.getByText("Mods")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("Mini-apps")).toBeTruthy();
    expect(screen.getByText("Themes")).toBeTruthy();
  });

  it("shows total packages available text", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    expect(screen.getByText("3 packages available")).toBeTruthy();
  });

  it("shows 'Get' button when featured package is not installed", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const heroActions = document.querySelector(".store-hero-actions");
    const btn = heroActions?.querySelector("button");
    expect(btn?.textContent).toBe("Get");
  });

  it("shows 'Installed' button when featured package is installed", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [{ packageId: "pkg-1", installedVersion: "1.0.0" }],
    });
    render(<StoreView {...defaultProps()} />);

    const heroActions = document.querySelector(".store-hero-actions");
    const btn = heroActions?.querySelector("button");
    expect(btn?.textContent).toBe("Installed");
  });

  it("shows download count for featured package", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const statusEl = document.querySelector(".store-hero .store-status");
    expect(statusEl?.textContent).toContain("100 installs");
  });

  it("shows version for featured package", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const versionEl = document.querySelector(".store-hero-version");
    expect(versionEl?.textContent).toBe("v1.0.0");
  });

  it("shows author name and initial avatar", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const heroAuthorName = document.querySelector(".store-hero .store-author-name");
    expect(heroAuthorName?.textContent).toBe("alice");

    const heroAvatar = document.querySelector(".store-hero .store-author-avatar");
    expect(heroAvatar?.textContent).toBe("A");
  });

  it("shows featured description", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const descEl = document.querySelector(".store-hero-desc");
    expect(descEl?.textContent).toBe("A test package");
  });
});

// ---------------------------------------------------------------------------
// Tests: PackageCard
// ---------------------------------------------------------------------------

describe("PackageCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders package name, author avatar, and description", () => {
    const pkg1 = makePkg({ packageId: "feat-pkg", name: "Featured Pkg", author: "eve", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card-pkg", name: "Card Pkg", author: "diana", description: "Card description", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });

    const { container } = render(<StoreView {...defaultProps()} />);
    const card = container.querySelector(".store-card");
    expect(card).toBeTruthy();

    const cardTitle = card?.querySelector(".store-card-title");
    expect(cardTitle?.textContent).toBe("Card Pkg");

    const cardDesc = card?.querySelector(".store-card-desc");
    expect(cardDesc?.textContent).toBe("Card description");

    const authorAvatar = card?.querySelector(".store-author-avatar");
    expect(authorAvatar?.textContent).toBe("D");

    const authorName = card?.querySelector(".store-card-author-name");
    expect(authorName?.textContent).toBe("diana");
  });

  it("shows 'Get' button when not installed", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const cardBtn = document.querySelector(".store-card-btn");
    expect(cardBtn?.textContent).toBe("Get");
    expect(cardBtn?.className).not.toContain("store-card-btn--installed");
  });

  it("shows 'Installed' button when package is installed", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [{ packageId: "card", installedVersion: "1.0.0" }],
    });
    render(<StoreView {...defaultProps()} />);

    const cardBtn = document.querySelector(".store-card-btn");
    expect(cardBtn?.textContent).toBe("Installed");
    expect(cardBtn?.className).toContain("store-card-btn--installed");
  });

  it("shows download count for packages with downloads", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 42 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const cardStatus = document.querySelector(".store-card .store-card-status");
    expect(cardStatus?.textContent).toContain("42 installs");
  });

  it("shows type name when downloads is 0", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", type: "canvas", downloads: 0 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const cardStatus = document.querySelector(".store-card .store-card-status");
    expect(cardStatus?.textContent).toContain("canvas");
  });

  it("shows custom icon when provided", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5, icon: "X" });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    const cardIcon = document.querySelector(".store-card .store-card-icon");
    expect(cardIcon?.textContent).toBe("X");
  });
});

// ---------------------------------------------------------------------------
// Tests: PackageDetail
// ---------------------------------------------------------------------------

describe("PackageDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state when package is not yet loaded", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
      selectedPkg: undefined,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    expect(screen.getByText("Loading package details...")).toBeTruthy();
  });

  it("shows back button on detail page", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
      selectedPkg: undefined,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    const backBtn = document.querySelector(".store-detail-back");
    expect(backBtn).toBeTruthy();
    expect(backBtn?.textContent).toContain("Back");
  });

  it("navigates back to browse when back button is clicked", () => {
    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const pkg2 = makePkg({ packageId: "card", name: "Card", downloads: 5 });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
      selectedPkg: undefined,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);
    expect(screen.getByText("Loading package details...")).toBeTruthy();

    const backBtn = document.querySelector(".store-detail-back") as HTMLElement;
    fireEvent.click(backBtn);

    expect(screen.queryByText("Loading package details...")).toBeNull();
  });

  it("renders full detail when package is loaded", () => {
    const detailPkg = makePkg({
      packageId: "detail-pkg",
      name: "Detail Package",
      author: "frank",
      description: "Detailed description here",
      type: "theme",
      version: "2.0.0",
      tags: ["ui", "dark"],
      downloads: 200,
      readme: "This is the readme content.",
    });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    expect(document.querySelector(".store-detail-name")?.textContent).toBe("Detail Package");
    expect(document.querySelector(".store-detail-author")?.textContent).toBe("by frank");
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByText("200 installs")).toBeTruthy();
    expect(document.querySelector(".store-detail-desc")?.textContent).toBe("Detailed description here");
    expect(document.querySelector(".store-detail-readme")?.textContent).toBe("This is the readme content.");

    const tagEls = document.querySelectorAll(".store-detail-tag");
    const tags = Array.from(tagEls).map((el) => el.textContent);
    expect(tags).toContain("ui");
    expect(tags).toContain("dark");
  });

  it("shows Get button for uninstalled package in detail", () => {
    const detailPkg = makePkg({ packageId: "detail-pkg", name: "Detail Package" });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    const detailBtn = document.querySelector(".store-detail-btn");
    expect(detailBtn?.textContent).toBe("Get");
  });

  it("shows Installed button for installed package in detail", () => {
    const detailPkg = makePkg({ packageId: "detail-pkg", name: "Detail Package" });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [{ packageId: "detail-pkg", installedVersion: "1.0.0" }],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    const detailBtn = document.querySelector(".store-detail-btn");
    expect(detailBtn?.textContent).toBe("Installed");
    expect(detailBtn?.className).toContain("store-detail-btn--installed");
  });

  it("does not render tags section when tags are empty", () => {
    const detailPkg = makePkg({ packageId: "detail-pkg", tags: [] });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    expect(document.querySelector(".store-detail-tags")).toBeNull();
  });

  it("does not render readme section when readme is absent", () => {
    const detailPkg = makePkg({ packageId: "detail-pkg", readme: undefined });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    expect(document.querySelector(".store-detail-readme")).toBeNull();
  });

  it("shows download count only when downloads > 0 in detail stats", () => {
    const detailPkg = makePkg({ packageId: "detail-pkg", downloads: 0, type: "canvas" });
    const pkg1 = makePkg({ packageId: "feat", downloads: 999 });
    setupUseQuery({
      browsePackages: [pkg1, detailPkg],
      allPackages: [pkg1, detailPkg],
      installed: [],
      selectedPkg: detailPkg,
    });
    render(<StoreView {...defaultProps()} />);

    const card = document.querySelector(".store-card") as HTMLElement;
    fireEvent.click(card);

    const statsEl = document.querySelector(".store-detail-stats");
    expect(statsEl?.textContent).not.toContain("installs");
    expect(statsEl?.textContent).toContain("canvas");
  });
});

// ---------------------------------------------------------------------------
// Tests: InstalledList
// ---------------------------------------------------------------------------

describe("InstalledList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when no packages are installed", () => {
    setupUseQuery({
      browsePackages: [],
      allPackages: [],
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");
    expect(screen.getByText("No installed packages")).toBeTruthy();
  });

  it("shows empty state when installedRecords is undefined", () => {
    setupUseQuery({
      browsePackages: [],
      allPackages: [],
      installed: undefined,
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");
    expect(screen.getByText("No installed packages")).toBeTruthy();
  });

  it("renders installed items with package info", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
        { packageId: "pkg-2", installedVersion: "0.9.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const installedItems = document.querySelectorAll(".store-installed-item");
    expect(installedItems.length).toBe(2);

    const names = document.querySelectorAll(".store-installed-name");
    const nameTexts = Array.from(names).map((el) => el.textContent);
    expect(nameTexts).toContain("Alpha Skill");
    expect(nameTexts).toContain("Beta Canvas");
  });

  it("shows version for each installed item", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const versions = document.querySelectorAll(".store-installed-version");
    expect(versions[0]?.textContent).toBe("v1.0.0");
  });

  it("shows Uninstall button for each installed item", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const uninstallBtn = document.querySelector(".store-uninstall-btn");
    expect(uninstallBtn?.textContent).toBe("Uninstall");
  });

  it("falls back to packageId when package lookup misses", () => {
    setupUseQuery({
      browsePackages: [],
      allPackages: [],
      installed: [
        { packageId: "unknown-pkg", installedVersion: "1.0.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const name = document.querySelector(".store-installed-name");
    expect(name?.textContent).toBe("unknown-pkg");
  });

  it("navigates to detail when installed item is clicked", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
      ],
      selectedPkg: samplePackages[0],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const item = document.querySelector(".store-installed-item") as HTMLElement;
    fireEvent.click(item);

    const detailBack = document.querySelector(".store-detail-back");
    expect(detailBack).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: UpdatesList
// ---------------------------------------------------------------------------

describe("UpdatesList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when all packages are up to date", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Updates");
    expect(screen.getByText("All packages are up to date")).toBeTruthy();
  });

  it("shows empty state when no packages are installed", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Updates");
    expect(screen.getByText("All packages are up to date")).toBeTruthy();
  });

  it("shows update items with version arrows when updates are available", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-2", installedVersion: "0.9.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Updates");

    const updateItems = document.querySelectorAll(".store-installed-item");
    expect(updateItems.length).toBe(1);

    const name = document.querySelector(".store-installed-name");
    expect(name?.textContent).toBe("Beta Canvas");

    const version = document.querySelector(".store-installed-version");
    expect(version?.textContent).toContain("v0.9.0");
    expect(version?.textContent).toContain("v1.0.0");
  });

  it("shows Update button for each update item", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-2", installedVersion: "0.9.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Updates");

    const updateBtn = document.querySelector(".store-update-btn");
    expect(updateBtn?.textContent).toBe("Update");
  });

  it("does not show packages that are up to date in updates list", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-1", installedVersion: "1.0.0" },
        { packageId: "pkg-2", installedVersion: "0.5.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    clickTab("Updates");

    const items = document.querySelectorAll(".store-installed-item");
    expect(items.length).toBe(1);

    const name = document.querySelector(".store-installed-name");
    expect(name?.textContent).toBe("Beta Canvas");
  });

  it("updates count is reflected in featured hero", () => {
    setupUseQuery({
      browsePackages: samplePackages,
      allPackages: samplePackages,
      installed: [
        { packageId: "pkg-2", installedVersion: "0.5.0" },
        { packageId: "pkg-3", installedVersion: "0.1.0" },
      ],
    });
    render(<StoreView {...defaultProps()} />);

    const statValues = document.querySelectorAll(".store-hero-stat-val");
    const statLabels = document.querySelectorAll(".store-hero-stat-lbl");

    const stats: Record<string, string> = {};
    statLabels.forEach((lbl, i) => {
      stats[lbl.textContent ?? ""] = statValues[i]?.textContent ?? "";
    });

    expect(stats["Updates"]).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Tests: Install / Uninstall actions
// ---------------------------------------------------------------------------

describe("Install and Uninstall actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls installMutation when Get button is clicked on a card", async () => {
    const mockInstall = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return mockInstall;
      if (mutationPath === "store_packages.uninstall") return vi.fn();
      return vi.fn();
    });

    const pkg1 = makePkg({ packageId: "feat", downloads: 99, type: "mod" });
    const pkg2 = makePkg({ packageId: "card-pkg", name: "Card", downloads: 5, type: "mod" });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [],
    });

    const onComposePrompt = vi.fn();
    render(<StoreView {...defaultProps({ onComposePrompt })} />);

    const cardBtn = document.querySelector(".store-card-btn") as HTMLElement;
    expect(cardBtn?.textContent).toBe("Get");

    await act(async () => {
      fireEvent.click(cardBtn);
    });

    expect(mockSetView).toHaveBeenCalledWith("chat");
    expect(onComposePrompt).toHaveBeenCalled();
  });

  it("calls uninstallMutation when Installed button is clicked on a card", async () => {
    const mockUninstall = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return vi.fn();
      if (mutationPath === "store_packages.uninstall") return mockUninstall;
      return vi.fn();
    });

    const pkg1 = makePkg({ packageId: "feat", downloads: 99, type: "mod" });
    const pkg2 = makePkg({ packageId: "card-pkg", name: "Card", downloads: 5, type: "mod" });
    setupUseQuery({
      browsePackages: [pkg1, pkg2],
      allPackages: [pkg1, pkg2],
      installed: [{ packageId: "card-pkg", installedVersion: "1.0.0" }],
    });

    const onComposePrompt = vi.fn();
    render(<StoreView {...defaultProps({ onComposePrompt })} />);

    const cardBtn = document.querySelector(".store-card-btn--installed") as HTMLElement;
    expect(cardBtn?.textContent).toBe("Installed");

    await act(async () => {
      fireEvent.click(cardBtn);
    });

    expect(mockSetView).toHaveBeenCalledWith("chat");
    expect(onComposePrompt).toHaveBeenCalled();
  });

  it("calls uninstallMutation when Uninstall is clicked in InstalledList", async () => {
    const mockUninstall = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return vi.fn();
      if (mutationPath === "store_packages.uninstall") return mockUninstall;
      return vi.fn();
    });

    const pkg = makePkg({ packageId: "pkg-1", name: "Alpha Skill", type: "skill", downloads: 100 });
    setupUseQuery({
      browsePackages: [pkg],
      allPackages: [pkg],
      installed: [{ packageId: "pkg-1", installedVersion: "1.0.0" }],
    });

    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const uninstallBtn = document.querySelector(".store-uninstall-btn") as HTMLElement;
    expect(uninstallBtn?.textContent).toBe("Uninstall");

    await act(async () => {
      fireEvent.click(uninstallBtn);
    });

    expect(mockUninstall).toHaveBeenCalledWith({ packageId: "pkg-1" });
  });

  it("calls installMutation when Update is clicked in UpdatesList", async () => {
    const mockInstall = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return mockInstall;
      if (mutationPath === "store_packages.uninstall") return vi.fn();
      return vi.fn();
    });

    const pkg = makePkg({ packageId: "pkg-1", name: "Alpha Mod", type: "mod", downloads: 100 });
    setupUseQuery({
      browsePackages: [pkg],
      allPackages: [pkg],
      installed: [{ packageId: "pkg-1", installedVersion: "0.5.0" }],
    });

    const onComposePrompt = vi.fn();
    render(<StoreView {...defaultProps({ onComposePrompt })} />);

    clickTab("Updates");

    const updateBtn = document.querySelector(".store-update-btn") as HTMLElement;
    expect(updateBtn?.textContent).toBe("Update");

    await act(async () => {
      fireEvent.click(updateBtn);
    });

    expect(mockSetView).toHaveBeenCalledWith("chat");
    expect(onComposePrompt).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: Skill install with electronAPI
// ---------------------------------------------------------------------------

describe("Skill install with electronAPI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls electronAPI.storeInstallSkill for skill type packages", async () => {
    const mockInstall = vi.fn().mockResolvedValue(undefined);
    const mockStoreInstallSkill = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return mockInstall;
      return vi.fn();
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      storeInstallSkill: mockStoreInstallSkill,
    };

    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const skillPkg = makePkg({
      packageId: "skill-pkg",
      name: "My Skill",
      type: "skill",
      downloads: 5,
      modPayload: { markdown: "# Skill content", agentTypes: ["general", "browser"], tags: ["api"] },
    });
    setupUseQuery({
      browsePackages: [pkg1, skillPkg],
      allPackages: [pkg1, skillPkg],
      installed: [],
    });

    render(<StoreView {...defaultProps()} />);

    const cardBtn = document.querySelector(".store-card-btn") as HTMLElement;
    await act(async () => {
      fireEvent.click(cardBtn);
    });

    expect(mockStoreInstallSkill).toHaveBeenCalledWith({
      packageId: "skill-pkg",
      skillId: "skill-pkg",
      name: "My Skill",
      markdown: "# Skill content",
      agentTypes: ["general", "browser"],
      tags: ["api"],
    });
    expect(mockInstall).toHaveBeenCalledWith({ packageId: "skill-pkg", version: "1.0.0" });

    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  it("throws when skill package has no markdown in modPayload", async () => {
    const mockInstall = vi.fn().mockResolvedValue(undefined);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return mockInstall;
      return vi.fn();
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      storeInstallSkill: vi.fn(),
    };

    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const skillPkg = makePkg({
      packageId: "bad-skill",
      name: "Bad Skill",
      type: "skill",
      downloads: 5,
      modPayload: {},
    });
    setupUseQuery({
      browsePackages: [pkg1, skillPkg],
      allPackages: [pkg1, skillPkg],
      installed: [],
    });

    render(<StoreView {...defaultProps()} />);

    const cardBtn = document.querySelector(".store-card-btn") as HTMLElement;
    await act(async () => {
      fireEvent.click(cardBtn);
    });

    expect(consoleSpy).toHaveBeenCalled();
    const errorCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Install failed"),
    );
    expect(errorCall).toBeTruthy();

    expect(mockInstall).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });
});

// ---------------------------------------------------------------------------
// Tests: Theme install/uninstall
// ---------------------------------------------------------------------------

describe("Theme install/uninstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls electronAPI.storeInstallTheme and registerTheme for theme type", async () => {
    const { registerTheme } = await import("@/theme/themes");
    const mockInstall = vi.fn().mockResolvedValue(undefined);
    const mockStoreInstallTheme = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.install") return mockInstall;
      return vi.fn();
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      storeInstallTheme: mockStoreInstallTheme,
    };

    const pkg1 = makePkg({ packageId: "feat", downloads: 99 });
    const themePkg = makePkg({
      packageId: "theme-pkg",
      name: "My Theme",
      type: "theme",
      downloads: 5,
      modPayload: {
        light: { background: "#fff" },
        dark: { background: "#000" },
      },
    });
    setupUseQuery({
      browsePackages: [pkg1, themePkg],
      allPackages: [pkg1, themePkg],
      installed: [],
    });

    render(<StoreView {...defaultProps()} />);

    const cardBtn = document.querySelector(".store-card-btn") as HTMLElement;
    await act(async () => {
      fireEvent.click(cardBtn);
    });

    expect(mockStoreInstallTheme).toHaveBeenCalled();
    expect(registerTheme).toHaveBeenCalled();
    expect(mockInstall).toHaveBeenCalledWith({ packageId: "theme-pkg", version: "1.0.0" });

    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  it("calls unregisterTheme when uninstalling a theme", async () => {
    const { unregisterTheme } = await import("@/theme/themes");
    const mockUninstall = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      if (mutationPath === "store_packages.uninstall") return mockUninstall;
      return vi.fn();
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      storeUninstall: vi.fn().mockResolvedValue(undefined),
    };

    const themePkg = makePkg({
      packageId: "theme-pkg",
      name: "My Theme",
      type: "theme",
      downloads: 100,
    });
    setupUseQuery({
      browsePackages: [themePkg],
      allPackages: [themePkg],
      installed: [{ packageId: "theme-pkg", installedVersion: "1.0.0" }],
    });

    render(<StoreView {...defaultProps()} />);

    clickTab("Installed");

    const uninstallBtn = document.querySelector(".store-uninstall-btn") as HTMLElement;
    await act(async () => {
      fireEvent.click(uninstallBtn);
    });

    expect(unregisterTheme).toHaveBeenCalledWith("theme-pkg");
    expect(mockUninstall).toHaveBeenCalledWith({ packageId: "theme-pkg" });

    delete (window as unknown as Record<string, unknown>).electronAPI;
  });
});
