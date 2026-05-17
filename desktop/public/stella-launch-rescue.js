// Drives the launch splash's "taking longer than usual" rescue affordance.
// Loaded as an external script from `desktop/index.html` because the page's
// CSP forbids inline <script>. After RESCUE_DELAY_MS without React removing
// the splash, surfaces Restart app + Undo last change buttons.
(function () {
  var RESCUE_DELAY_MS = 8000;
  var launch = document.getElementById("stella-launch");
  var rescue = document.getElementById("stella-launch-rescue");
  var restartBtn = document.getElementById("stella-launch-restart");
  var undoBtn = document.getElementById("stella-launch-undo");
  if (!launch || !rescue || !restartBtn || !undoBtn) return;

  var timer = window.setTimeout(function () {
    if (!document.body.contains(launch)) return;
    rescue.setAttribute("data-visible", "true");
  }, RESCUE_DELAY_MS);

  var observer = new MutationObserver(function () {
    if (!document.body.contains(launch)) {
      window.clearTimeout(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  var setBusy = function (busy) {
    restartBtn.disabled = busy;
    undoBtn.disabled = busy;
  };

  var relaunchOrReload = function () {
    var api = window.electronAPI;
    if (api && api.ui && typeof api.ui.relaunch === "function") {
      try {
        api.ui.relaunch();
        return;
      } catch (_) {
        // Fall through to reload.
      }
    }
    window.location.reload();
  };

  restartBtn.addEventListener("click", function () {
    setBusy(true);
    relaunchOrReload();
  });

  undoBtn.addEventListener("click", function () {
    setBusy(true);
    var api = window.electronAPI;
    var revert =
      api && api.agent && typeof api.agent.selfModRevert === "function"
        ? api.agent.selfModRevert(undefined, 1)
        : Promise.reject(new Error("selfModRevert unavailable"));
    Promise.resolve(revert)
      .catch(function () {
        // Best-effort: relaunch even if revert errored so the user isn't
        // stranded on the splash. The error surfaces in main-process logs.
      })
      .then(relaunchOrReload);
  });
})();
