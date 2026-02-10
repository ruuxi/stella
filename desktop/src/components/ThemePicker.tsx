import { useState, useMemo } from "react";
import { useTheme } from "../theme/theme-context";
import { Popover, PopoverContent, PopoverTrigger, PopoverBody } from "./popover";
import { Button } from "./button";
import { ChevronUp, Check } from "lucide-react";

type ColorScheme = "light" | "dark" | "system";
type GradientMode = "soft" | "crisp";
type GradientColor = "relative" | "strong";

const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

const GRADIENT_MODES: { id: GradientMode; label: string }[] = [
  { id: "soft", label: "Soft" },
  { id: "crisp", label: "Crisp" },
];

const GRADIENT_COLORS: { id: GradientColor; label: string }[] = [
  { id: "relative", label: "Relative" },
  { id: "strong", label: "Strong" },
];

interface ThemePickerProps {
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
}

export function ThemePicker({ 
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onThemeSelect,
}: ThemePickerProps) {
  const {
    themeId,
    themes,
    setTheme,
    colorMode,
    setColorMode,
    gradientMode,
    setGradientMode,
    gradientColor,
    setGradientColor,
    previewTheme,
    cancelThemePreview,
    previewGradientMode,
    cancelGradientModePreview,
    previewGradientColor,
    cancelGradientColorPreview,
    cancelPreview,
  } = useTheme();

  const [internalOpen, setInternalOpen] = useState(false);

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;

  const sortedThemes = useMemo(
    () => [...themes].sort((a, b) => a.name.localeCompare(b.name)),
    [themes]
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) cancelPreview();
      }}
    >
      <PopoverTrigger asChild>
        <Button 
          variant="ghost" 
          size="normal" 
          data-slot="theme-picker-trigger"
          style={hideTrigger ? { opacity: 0, pointerEvents: 'none', position: 'absolute' } : undefined}
          tabIndex={hideTrigger ? -1 : undefined}
          aria-hidden={hideTrigger}
        >
          theme
          <ChevronUp size={12} />
        </Button>
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

              <div data-slot="theme-picker-label">Gradient</div>
              <div
                data-slot="theme-picker-button-row"
                onMouseLeave={() => cancelGradientModePreview()}
              >
                {GRADIENT_MODES.map((mode) => (
                  <Button
                    key={mode.id}
                    size="small"
                    variant={gradientMode === mode.id ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientMode(mode.id)}
                    onMouseEnter={() => previewGradientMode(mode.id)}
                    onFocus={() => previewGradientMode(mode.id)}
                  >
                    {mode.label}
                  </Button>
                ))}
              </div>

              <div data-slot="theme-picker-label">Color</div>
              <div
                data-slot="theme-picker-button-row"
                onMouseLeave={() => cancelGradientColorPreview()}
              >
                {GRADIENT_COLORS.map((color) => (
                  <Button
                    key={color.id}
                    size="small"
                    variant={gradientColor === color.id ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientColor(color.id)}
                    onMouseEnter={() => previewGradientColor(color.id)}
                    onFocus={() => previewGradientColor(color.id)}
                  >
                    {color.label}
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
