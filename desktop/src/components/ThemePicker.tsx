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

export function ThemePicker() {
  const {
    theme,
    themes,
    setTheme,
    colorMode,
    setColorMode,
    gradientMode,
    setGradientMode,
    gradientColor,
    setGradientColor,
  } = useTheme();

  const [open, setOpen] = useState(false);

  // Sort themes alphabetically by name
  const sortedThemes = useMemo(
    () => [...themes].sort((a, b) => a.name.localeCompare(b.name)),
    [themes]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="normal" data-slot="theme-picker-trigger">
          theme
          <ChevronUp size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" data-theme-picker="true">
        <PopoverBody>
          <div data-slot="theme-picker-sections">
            {/* Appearance Section */}
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

              {/* Gradient Mode */}
              <div data-slot="theme-picker-label">Gradient</div>
              <div data-slot="theme-picker-button-row">
                {GRADIENT_MODES.map((mode) => (
                  <Button
                    key={mode.id}
                    size="small"
                    variant={gradientMode === mode.id ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientMode(mode.id)}
                  >
                    {mode.label}
                  </Button>
                ))}
              </div>

              {/* Gradient Color */}
              <div data-slot="theme-picker-label">Color</div>
              <div data-slot="theme-picker-button-row">
                {GRADIENT_COLORS.map((color) => (
                  <Button
                    key={color.id}
                    size="small"
                    variant={gradientColor === color.id ? "secondary" : "ghost"}
                    data-slot="theme-picker-option-button"
                    onClick={() => setGradientColor(color.id)}
                  >
                    {color.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Theme List Section */}
            <div data-slot="theme-picker-theme-list">
              {sortedThemes.map((t) => {
                const isSelected = t.id === theme.id;
                return (
                  <Button
                    key={t.id}
                    size="normal"
                    variant={isSelected ? "secondary" : "ghost"}
                    data-slot="theme-picker-theme-button"
                    onClick={() => {
                      setTheme(t.id);
                      setOpen(false);
                    }}
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
