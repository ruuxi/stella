/**
 * Selection bridge injected into every canvas page the library protocol
 * serves (`/a/<slug>`). Ported from the srcdoc-era inline script in
 * CanvasTabContent.tsx: posts text-selection state and data-stella-compose
 * clicks to the parent (the library shell), which relays them — with rect
 * offsets applied — to the desktop renderer's Ask Stella chip.
 */

(() => {
  const composeButton = document.createElement("button");
  composeButton.type = "button";
  composeButton.textContent = "Ask Stella";
  composeButton.setAttribute("aria-label", "Ask Stella about this");
  Object.assign(composeButton.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "none",
    alignItems: "center",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "999px",
    background: "rgba(20,20,22,0.92)",
    color: "white",
    boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
    padding: "5px 9px",
    font: "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    cursor: "default",
  });
  (document.body || document.documentElement).appendChild(composeButton);
  let activeComposeText = "";
  let hideTimer = 0;

  const findComposeTarget = (target) => {
    if (!target || typeof target.closest !== "function") return null;
    return target.closest("[data-stella-compose]");
  };

  const readComposeText = (target) => {
    const raw = target.getAttribute("data-stella-compose") || target.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  };

  const showComposeButton = (target) => {
    window.clearTimeout(hideTimer);
    const text = readComposeText(target);
    if (!text) return;
    activeComposeText = text;
    const rect = target.getBoundingClientRect();
    composeButton.style.left = Math.max(8, Math.min(window.innerWidth - 104, rect.right - 96)) + "px";
    composeButton.style.top = Math.max(8, rect.top + 8) + "px";
    composeButton.style.display = "inline-flex";
  };

  const hideComposeButtonSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      composeButton.style.display = "none";
      activeComposeText = "";
    }, 180);
  };

  document.addEventListener("mouseover", (event) => {
    const target = findComposeTarget(event.target);
    if (target) showComposeButton(target);
  }, true);
  document.addEventListener("mouseout", (event) => {
    const target = findComposeTarget(event.target);
    if (target) hideComposeButtonSoon();
  }, true);
  composeButton.addEventListener("mouseover", () => window.clearTimeout(hideTimer));
  composeButton.addEventListener("mouseout", hideComposeButtonSoon);
  composeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeComposeText) {
      parent.postMessage({ type: "stella:canvas-compose", text: activeComposeText }, "*");
    }
    composeButton.style.display = "none";
  });

  const post = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const text = selection.toString();
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || !Number.isFinite(rect.left)) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    parent.postMessage({
      type: "stella:canvas-selection",
      selected: true,
      text,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }, "*");
  };
  window.addEventListener("mouseup", () => setTimeout(post, 0), true);
  document.addEventListener("selectionchange", () => setTimeout(post, 0));
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "stella:canvas-selection-clear") {
      window.getSelection()?.removeAllRanges();
      post();
    }
  });
})();
