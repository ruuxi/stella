import "./EmbeddedWebsiteGlassPlaceholder.css";

type EmbeddedWebsiteGlassPlaceholderProps = {
  visible: boolean;
  active: boolean;
  surfaceLabel: "Store" | "Billing";
};

export function EmbeddedWebsiteGlassPlaceholder({
  visible,
  active,
  surfaceLabel,
}: EmbeddedWebsiteGlassPlaceholderProps) {
  if (!visible) return null;

  return (
    <div
      className="embedded-website-glass-placeholder"
      data-active={active || undefined}
      aria-hidden="true"
    >
      <div className="embedded-website-glass-placeholder__message">
        Close to return to {surfaceLabel}
      </div>
    </div>
  );
}
