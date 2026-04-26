const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/kfnchfpocpmdblhfgcnpfaaebaioojnl?utm_source=item-share-cb";

type ExtensionPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

const openWebStore = () => {
  if (window.electronAPI?.system.openExternal) {
    window.electronAPI.system.openExternal(CHROME_WEB_STORE_URL);
    return;
  }
  window.open(CHROME_WEB_STORE_URL, "_blank", "noopener,noreferrer");
};

export function OnboardingExtensionPhase({
  splitTransitionActive,
  onContinue,
}: ExtensionPhaseProps) {
  return (
    <div className="onboarding-step-content onboarding-extension-step">
      <div className="onboarding-step-label">Browser extension</div>
      <p className="onboarding-step-desc">
        Add the Stella extension to Chrome so Stella can read the page you're
        on, follow links, and act on your behalf inside the browser. Works in
        Chrome and Chromium-based browsers like Arc, Brave, and Edge.
      </p>

      <div className="onboarding-extension-card">
        <img
          className="onboarding-extension-card__icon"
          src="stella-extension-icon-128.png"
          alt=""
          width={96}
          height={96}
          draggable={false}
        />
        <div className="onboarding-extension-card__info">
          <span className="onboarding-extension-card__title">
            Stella for Chrome
          </span>
          <span className="onboarding-extension-card__desc">
            Lets Stella see the page you're on and take actions in your
            browser.
          </span>
        </div>
        <button
          className="onboarding-permission-card__action"
          onClick={openWebStore}
        >
          Get extension
        </button>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
