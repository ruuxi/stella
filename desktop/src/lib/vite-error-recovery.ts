/**
 * Watches for Vite's error overlay and injects a "Undo recent changes" button.
 * This provides Level 1 crash recovery when a self-mod introduces a compile error.
 */

function injectRevertButton(overlay: Element) {
  // Avoid injecting twice
  if (overlay.querySelector("[data-selfmod-revert]")) return;

  const container = document.createElement("div");
  container.setAttribute("data-selfmod-revert", "true");
  container.style.cssText =
    "display:flex;gap:8px;justify-content:center;margin-top:16px;padding:12px;";

  const revertBtn = document.createElement("button");
  revertBtn.textContent = "Undo recent changes";
  revertBtn.style.cssText =
    "padding:8px 16px;font-size:13px;border-radius:8px;border:1px solid #555;background:#333;color:#fff;cursor:pointer;";
  revertBtn.addEventListener("click", async () => {
    revertBtn.disabled = true;
    revertBtn.textContent = "Reverting...";
    try {
      const featureId = await window.electronAPI?.agent.getLastSelfModFeature();
      if (featureId) {
        await window.electronAPI?.agent.selfModRevert(featureId);
      }
      window.location.reload();
    } catch {
      window.location.reload();
    }
  });

  const reloadBtn = document.createElement("button");
  reloadBtn.textContent = "Reload";
  reloadBtn.style.cssText =
    "padding:8px 16px;font-size:13px;border-radius:8px;border:1px solid #555;background:transparent;color:#fff;cursor:pointer;";
  reloadBtn.addEventListener("click", () => window.location.reload());

  container.appendChild(revertBtn);
  container.appendChild(reloadBtn);

  // Vite error overlay uses shadow DOM — try to inject inside it
  const shadowRoot = overlay.shadowRoot;
  if (shadowRoot) {
    const messageBody =
      shadowRoot.querySelector(".message-body") ??
      shadowRoot.querySelector(".window") ??
      shadowRoot.querySelector("div");
    if (messageBody) {
      messageBody.appendChild(container);
      return;
    }
  }

  // Fallback: append after the overlay element
  overlay.after(container);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement && node.tagName === "VITE-ERROR-OVERLAY") {
        // Small delay to let the overlay render its shadow DOM content
        setTimeout(() => injectRevertButton(node), 100);
      }
    }
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
