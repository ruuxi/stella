/**
 * Watches for Vite's error overlay and injects Git-backed recovery controls.
 */

type SelfModFeatureSummary = {
  featureId: string;
  name: string;
  description: string;
  latestCommit: string;
  latestTimestampMs: number;
  commitCount: number;
};

const createButton = (label: string, style: string) => {
  const button = document.createElement("button");
  button.textContent = label;
  button.style.cssText = style;
  return button;
};

const loadRecentFeatures = async (): Promise<SelfModFeatureSummary[]> => {
  try {
    const rows = await window.electronAPI?.agent.listSelfModFeatures(4);
    return rows ?? [];
  } catch {
    return [];
  }
};

async function injectRevertButton(overlay: Element) {
  if (overlay.querySelector("[data-selfmod-revert]")) return;

  const container = document.createElement("div");
  container.setAttribute("data-selfmod-revert", "true");
  container.style.cssText =
    "display:flex;flex-direction:column;gap:8px;justify-content:center;margin-top:16px;padding:12px;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:center;flex-wrap:wrap;";

  const status = document.createElement("div");
  status.style.cssText = "text-align:center;font-size:12px;opacity:0.8;";

  const allButtons: HTMLButtonElement[] = [];
  const disableButtons = (disabled: boolean) => {
    allButtons.forEach((button) => {
      button.disabled = disabled;
    });
  };

  const runRevert = async (featureId?: string) => {
    disableButtons(true);
    status.textContent = "Reverting...";
    try {
      await window.electronAPI?.agent.selfModRevert(featureId, 1);
      window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  const features = await loadRecentFeatures();
  if (features.length > 0) {
    for (const feature of features) {
      const btn = createButton(
        `Undo ${feature.name}`,
        "padding:8px 14px;font-size:12px;border-radius:8px;border:1px solid #555;background:#333;color:#fff;cursor:pointer;",
      );
      btn.addEventListener("click", () => {
        void runRevert(feature.featureId);
      });
      allButtons.push(btn);
      row.appendChild(btn);
    }
  } else {
    const revertBtn = createButton(
      "Undo latest update",
      "padding:8px 14px;font-size:12px;border-radius:8px;border:1px solid #555;background:#333;color:#fff;cursor:pointer;",
    );
    revertBtn.addEventListener("click", () => {
      void runRevert();
    });
    allButtons.push(revertBtn);
    row.appendChild(revertBtn);
  }

  const reloadBtn = createButton(
    "Reload",
    "padding:8px 14px;font-size:12px;border-radius:8px;border:1px solid #555;background:transparent;color:#fff;cursor:pointer;",
  );
  reloadBtn.addEventListener("click", () => window.location.reload());
  allButtons.push(reloadBtn);
  row.appendChild(reloadBtn);

  container.appendChild(row);
  container.appendChild(status);

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

  overlay.after(container);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement && node.tagName === "VITE-ERROR-OVERLAY") {
        setTimeout(() => {
          void injectRevertButton(node);
        }, 100);
      }
    }
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
