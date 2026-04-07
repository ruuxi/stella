import {
  useState,
  useMemo,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { Popover, PopoverContent, PopoverTrigger, PopoverBody } from "@/ui/popover";
import { Button } from "@/ui/button";
import { Check } from "lucide-react";
import "./ThemePicker.css";

type ColorScheme = "light" | "dark" | "system";

type ThemePickerTriggerProps = {
  style?: CSSProperties;
  tabIndex?: number;
  "aria-hidden"?: boolean;
  "data-slot"?: string;
};

const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

interface ThemePickerProps {
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  /** Custom trigger (e.g. icon button). Defaults to a text Button. */
  trigger?: ReactElement;
  /** Used only when `trigger` is omitted. */
  triggerLabel?: string;
}

export function ThemePicker({
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onThemeSelect,
  trigger,
  triggerLabel = "Theme",
}: ThemePickerProps) {
  const { themeId, themes, colorMode, gradientMode, gradientColor } = useTheme();
  const {
    setTheme,
    setColorMode,
    setGradientMode,
    setGradientColor,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
  } = useThemeControl();

  const [internalOpen, setInternalOpen] = useState(false);

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;

  const sortedThemes = useMemo(
    () => [...themes].sort((a, b) => a.name.localeCompare(b.name)),
    [themes]
  );

  const triggerElement =
    trigger && isValidElement<ThemePickerTriggerProps>(trigger) ? trigger : null;

  const popoverTrigger =
    triggerElement
      ? cloneElement(triggerElement, {
          "data-slot": "theme-picker-trigger",
          ...(hideTrigger
            ? {
                style: {
                  ...(typeof triggerElement.props.style === "object" &&
                  triggerElement.props.style !== null &&
                  !Array.isArray(triggerElement.props.style)
                    ? triggerElement.props.style
                    : {}),
                  opacity: 0,
                  pointerEvents: "none",
                  position: "absolute",
                },
                tabIndex: -1,
                "aria-hidden": true,
              }
            : {}),
        })
      : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) cancelPreview();
      }}
    >
      <PopoverTrigger asChild>
        {popoverTrigger ?? (
          <Button
            variant="ghost"
            size="normal"
            data-slot="theme-picker-trigger"
            style={
              hideTrigger
                ? { opacity: 0, pointerEvents: "none", position: "absolute" }
                : undefined
            }
            tabIndex={hideTrigger ? -1 : undefined}
            aria-hidden={hideTrigger}
          >
            {triggerLabel}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" data-theme-picker="true">
        <PopoverBody>
          <div data-slot="theme-picker-sections" onMouseLeave={() => cancelPreview()}>
            <div data-slot="theme-picker-section" data-bordered>
              <div data-slot="theme-picker-label">Appearance</div>
              <div data-slot="theme-picker-button-row">
                {COLOR_SCHEMES.map((scheme) => (
                  <Button
                    key={scheme.id}
                    size="small"
                    variant={colorMode === scheme.id ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setColorMode(scheme.id)}
                  >
                    {scheme.label}
                  </Button>
                ))}
              </div>
            </div>

            <div data-slot="theme-picker-section" data-bordered>
              <div data-slot="theme-picker-label">Gradient Style</div>
              <div data-slot="theme-picker-button-row">
                {(["soft", "flat"] as const).map((value) => (
                  <Button
                    key={value}
                    size="small"
                    variant={gradientMode === value ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientMode(value)}
                  >
                    {value === "soft" ? "Soft" : "Flat"}
                  </Button>
                ))}
              </div>

              <div data-slot="theme-picker-label">Gradient Color</div>
              <div data-slot="theme-picker-button-row">
                {(["relative", "strong"] as const).map((value) => (
                  <Button
                    key={value}
                    size="small"
                    variant={gradientColor === value ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientColor(value)}
                  >
                    {value === "relative" ? "Relative" : "Strong"}
                  </Button>
                ))}
              </div>
            </div>

            <div
              data-slot="theme-picker-theme-list"
              onMouseLeave={() => cancelThemePreview()}
            >
              {sortedThemes.map((t) => {
                const isSelected = t.id === themeId;
                return (
                  <Button
                    key={t.id}
                    size="normal"
                    variant={isSelected ? "secondary" : "ghost"}
                    data-slot="theme-picker-theme-button"
                    onClick={() => {
                      setTheme(t.id);
                      cancelPreview();
                      setOpen(false);
                      onThemeSelect?.();
                    }}
                    onMouseEnter={() => previewTheme(t.id)}
                    onFocus={() => previewTheme(t.id)}
                  >
                    <span data-slot="theme-picker-theme-name">{t.name}</span>
                    {isSelected && (
                      <Check size={12} data-slot="theme-picker-check" />
                    )}
                  </Button>
                );
              })}
            </div>
          </div>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
