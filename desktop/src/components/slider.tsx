import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export interface SliderProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  label?: string;
  showValue?: boolean;
  formatValue?: (value: number) => string;
}

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, label, showValue, formatValue, value, ...props }, ref) => {
  const displayValue = React.useMemo(() => {
    if (!value || !Array.isArray(value) || value.length === 0) return "";
    const fn = formatValue ?? ((v: number) => String(v));
    return fn(value[0]);
  }, [value, formatValue]);

  return (
    <div data-component="slider" className={cn(className)}>
      {(label || showValue) && (
        <div data-slot="slider-header">
          {label && <label data-slot="slider-label">{label}</label>}
          {showValue && <span data-slot="slider-value">{displayValue}</span>}
        </div>
      )}
      <SliderPrimitive.Root ref={ref} value={value} data-slot="slider-root" {...props}>
        <SliderPrimitive.Track data-slot="slider-track">
          <SliderPrimitive.Range data-slot="slider-fill" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb data-slot="slider-thumb" />
      </SliderPrimitive.Root>
    </div>
  );
});

Slider.displayName = "Slider";
