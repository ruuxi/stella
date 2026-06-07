(function () {
  var root = document.documentElement;

  var readStorage = function (key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (_error) {
      return null;
    }
  };

  var params = new URLSearchParams(window.location.search);
  root.dataset.stellaWindow = params.get("window") === "mini" ? "mini" : "full";

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
    var reduce = false;
    if (window.matchMedia) {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (
      reduce ||
      (cores > 0 && cores <= 4) ||
      (mem > 0 && mem <= 4)
    ) {
      root.setAttribute("data-low-power", "true");
    }
  } catch (_error) {}
})();
