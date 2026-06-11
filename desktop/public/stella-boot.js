(function () {
  var root = document.documentElement;

  // Shared UI state snapshot (~/.stella/ui-state.json), exposed before this
  // script by the Electron preload or the dev server's injected inline
  // script. localStorage remains only as a first-boot-after-migration
  // fallback while the shared store is still empty.
  var uiState = window.__stellaUiState || {};

  var readStorage = function (key) {
    if (Object.prototype.hasOwnProperty.call(uiState, key)) {
      return uiState[key];
    }
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (_error) {
      return null;
    }
  };

  var params = new URLSearchParams(window.location.search);
  root.dataset.stellaWindow = params.get("window") === "mini" ? "mini" : "full";
  var forceLowPower = params.get("lowPower") === "1";

  try {
    if (window.sessionStorage && sessionStorage.getItem("stella:morph-reload") === "1") {
      root.dataset.stellaMorphReload = "true";
      sessionStorage.removeItem("stella:morph-reload");
    }
  } catch (_error) {}

  var themeId = readStorage("stella-theme-id") || "pearl";
  var colorMode = readStorage("stella-color-mode") || "light";
  var resolvedColorMode = "light";
  if (themeId === "noir") {
    resolvedColorMode = "dark";
  } else if (themeId === "pearl") {
    resolvedColorMode = "light";
  } else if (colorMode === "dark") {
    resolvedColorMode = "dark";
  } else if (
    colorMode === "system" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    resolvedColorMode = "dark";
  }
  root.dataset.stellaBootTheme = resolvedColorMode;
  root.classList.toggle("dark", resolvedColorMode === "dark");
  root.style.setProperty("color-scheme", resolvedColorMode);

  if (readStorage("stella:sidebar:visible") === "0") {
    root.dataset.sidebarHidden = "true";
  }

  var displayPanelWidth = Number(readStorage("stella.displayPanel.width"));
  if (Number.isFinite(displayPanelWidth) && displayPanelWidth > 0) {
    var clampedWidth = Math.min(
      1600,
      Math.max(320, Math.round(displayPanelWidth)),
    );
    root.style.setProperty("--display-panel-width", clampedWidth + "px");
  }

  var lastLocation = readStorage("stella:lastLocation");
  if (lastLocation && lastLocation[0] === "/" && lastLocation.length <= 2048) {
    var route = lastLocation.split(/[?#]/)[0].split("/")[1] || "home";
    root.dataset.stellaBootRoute = route;
  }

  // Low-power devices: drop blur entrances, decorative infinite loops, and
  // backdrop-filter glass before React paints. Mirrors shared/lib/device-perf.ts.
  try {
    var n = navigator;
    var cores =
      typeof n.hardwareConcurrency === "number" ? n.hardwareConcurrency : 0;
    var mem = typeof n.deviceMemory === "number" ? n.deviceMemory : 0;
    var platform = typeof n.platform === "string" ? n.platform : "";
    var userAgent = typeof n.userAgent === "string" ? n.userAgent : "";
    var isWindows = /^Win/i.test(platform) || /\bWindows\b/i.test(userAgent);
    var reduce = false;
    if (window.matchMedia) {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (
      reduce ||
      forceLowPower ||
      (cores > 0 && cores <= 4) ||
      (mem > 0 && mem <= 4) ||
      (isWindows && mem > 0 && mem <= 8)
    ) {
      root.setAttribute("data-low-power", "true");
    }
  } catch (_error) {}
})();
