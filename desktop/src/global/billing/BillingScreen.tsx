import { EmbeddedWebsiteView } from "@/global/website-view/EmbeddedWebsiteView";
import { useEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";

export function BillingScreen() {
  const embeddedTheme = useEmbeddedWebsiteTheme();

  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <EmbeddedWebsiteView route="billing" theme={embeddedTheme} />
      </div>
    </div>
  );
}
