import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { NativeWebsiteOverlayRegistrar } from "@/shared/lib/native-website-overlay";

export interface SelectOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

interface SelectProps<T extends string = string> {
  value: T;
  onValueChange?: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  className?: string;
  placeholder?: React.ReactNode;
  "aria-label"?: string;
  /** Optional label rendered above the trigger. */
  label?: string;
  hideLabel?: boolean;
  id?: string;
  name?: string;
}

export function Select<T extends string = string>({
  value,
  onValueChange,
  options,
  disabled,
  className,
  placeholder,
  label,
  hideLabel,
  id,
  name,
  ...rest
}: SelectProps<T>) {
  const ariaLabel = rest["aria-label"];
  const selected = options.find((option) => option.value === value);
  const display = selected?.label ?? placeholder ?? "";

  return (
    <div data-component="select">
      {label ? (
        <label
          data-slot="select-label"
          htmlFor={id}
          className={hideLabel ? "sr-only" : undefined}
        >
          {label}
        </label>
      ) : null}
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger
          id={id}
          name={name}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          data-slot="select-trigger"
          className={cn(className)}
        >
          <span data-slot="select-value">{display}</span>
          <ChevronDown size={14} data-slot="select-icon" aria-hidden="true" />
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            data-component="dropdown-menu-content"
            data-slot="select-content"
            sideOffset={4}
            align="start"
            collisionPadding={8}
          >
            <NativeWebsiteOverlayRegistrar />
            <DropdownMenuPrimitive.RadioGroup
              value={value}
              onValueChange={(next) => onValueChange?.(next as T)}
              data-slot="dropdown-menu-radio-group"
            >
              {options.map((option) => (
                <DropdownMenuPrimitive.RadioItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  data-slot="dropdown-menu-radio-item"
                >
                  <DropdownMenuPrimitive.ItemIndicator data-slot="dropdown-menu-item-indicator">
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 8 8"
                      fill="currentColor"
                    >
                      <circle cx="4" cy="4" r="3" />
                    </svg>
                  </DropdownMenuPrimitive.ItemIndicator>
                  <span data-slot="select-item-label">{option.label}</span>
                </DropdownMenuPrimitive.RadioItem>
              ))}
            </DropdownMenuPrimitive.RadioGroup>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}
