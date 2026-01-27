import { useTheme } from "../theme/theme-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { Palette, Sun, Moon, Monitor } from "lucide-react";

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="theme-picker-trigger">
          <Palette className="h-4 w-4" />
          <span className="sr-only">Change theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="theme-picker-menu">
        <DropdownMenuLabel>Color Mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={colorMode} onValueChange={(v) => setColorMode(v as "light" | "dark" | "system")}>
          <DropdownMenuRadioItem value="light" className="theme-picker-item">
            <Sun className="h-4 w-4 mr-2" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" className="theme-picker-item">
            <Moon className="h-4 w-4 mr-2" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" className="theme-picker-item">
            <Monitor className="h-4 w-4 mr-2" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Gradient Style</DropdownMenuLabel>
        <div className="gradient-options">
          <div className="gradient-option-group">
            <DropdownMenuRadioGroup value={gradientMode} onValueChange={(v) => setGradientMode(v as "soft" | "crisp")}>
              <DropdownMenuRadioItem value="soft" className="theme-picker-item">
                Soft
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="crisp" className="theme-picker-item">
                Crisp
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </div>
          <div className="gradient-option-group">
            <DropdownMenuRadioGroup value={gradientColor} onValueChange={(v) => setGradientColor(v as "relative" | "strong")}>
              <DropdownMenuRadioItem value="relative" className="theme-picker-item">
                Relative
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="strong" className="theme-picker-item">
                Strong
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <div className="theme-picker-grid">
          {themes.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`theme-picker-theme ${t.id === theme.id ? "active" : ""}`}
            >
              <div className="theme-picker-preview">
                <div
                  className="theme-preview-swatch"
                  style={{
                    background: `linear-gradient(135deg, ${t.dark.background} 50%, ${t.dark.primary} 50%)`,
                  }}
                />
              </div>
              <span className="theme-picker-name">{t.name}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
