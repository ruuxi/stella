import { BillingTab } from "@/global/settings/BillingTab";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import "@/global/settings/settings.css";

/**
 * The full-page Billing surface. Visually piggybacks on the existing
 * settings panel chrome (scroll container with bottom fade) so plans,
 * meters, and the embedded Stripe checkout look consistent with other
 * settings-style screens, without growing the Settings sidebar.
 */
export function BillingScreen() {
  return (
    <div className="settings-screen">
      <div className="settings-layout settings-layout--standalone settings-layout--single">
        <SettingsPanel>
          <BillingTab />
        </SettingsPanel>
      </div>
    </div>
  );
}

export default BillingScreen;
