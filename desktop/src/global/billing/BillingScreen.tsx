import { EmbeddedWebsiteView } from "@/global/website-view/EmbeddedWebsiteView";
import { useEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";
import "./BillingScreen.css";

export function BillingPanel() {
  const embeddedTheme = useEmbeddedWebsiteTheme();

  return (
    <div className="billing-panel">
      <EmbeddedWebsiteView route="billing" theme={embeddedTheme} />
    </div>
  );
}

export function BillingScreen() {
  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <BillingPanel />
      </div>
    </div>
  );
}
