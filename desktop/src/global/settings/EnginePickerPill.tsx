import { useRef } from "react";
import type { ModelPickerEngine } from "./lib/engine-model-routing";

type Option = { id: ModelPickerEngine; label: string };

export function EnginePickerPill({
  className,
  options,
  value,
  disabled,
  onChange,
}: {
  className: string;
  options: readonly Option[];
  value: ModelPickerEngine;
  disabled?: boolean;
  onChange: (engine: ModelPickerEngine) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    refs.current[index]?.focus();
    onChange(option.id);
  };

  return (
    <div className={className} role="radiogroup" aria-label="Model engine">
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-active={selected || undefined}
            data-selected={selected || undefined}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                next = (index + 1) % options.length;
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                next = (index - 1 + options.length) % options.length;
              } else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = options.length - 1;
              else return;
              event.preventDefault();
              choose(next);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
