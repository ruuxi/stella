import * as React from "react";
import { cn } from "@/lib/utils";

export interface InlineInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onSave?: (value: string) => void;
}

export const InlineInput = React.forwardRef<HTMLInputElement, InlineInputProps>(
  ({ className, onSave, onBlur, onKeyDown, defaultValue, ...props }, ref) => {
    const [isEditing, setIsEditing] = React.useState(false);
    const [value, setValue] = React.useState(defaultValue?.toString() ?? "");
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => inputRef.current!);

    const handleSave = () => {
      setIsEditing(false);
      onSave?.(value);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      handleSave();
      onBlur?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleSave();
      } else if (e.key === "Escape") {
        setValue(defaultValue?.toString() ?? "");
        setIsEditing(false);
      }
      onKeyDown?.(e);
    };

    const handleClick = () => {
      setIsEditing(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    };

    return (
      <div
        data-component="inline-input"
        data-editing={isEditing || undefined}
        className={cn(className)}
        onClick={handleClick}
      >
        <input
          ref={inputRef}
          data-slot="inline-input-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          {...props}
        />
      </div>
    );
  }
);

InlineInput.displayName = "InlineInput";
