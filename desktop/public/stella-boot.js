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
})();
