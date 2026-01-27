import * as React from "react";
import { cn } from "@/lib/utils";

export interface ResizeHandleProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  onResize?: (delta: number) => void;
}

export const ResizeHandle = React.forwardRef<HTMLDivElement, ResizeHandleProps>(
  ({ className, orientation = "horizontal", onResize, ...props }, ref) => {
    const isDraggingRef = React.useRef(false);
    const startPosRef = React.useRef(0);

    const handleMouseDown = React.useCallback(
      (e: React.MouseEvent) => {
        isDraggingRef.current = true;
        startPosRef.current = orientation === "horizontal" ? e.clientX : e.clientY;
        document.body.style.cursor = orientation === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";

        const handleMouseMove = (e: MouseEvent) => {
          if (!isDraggingRef.current) return;
          const currentPos = orientation === "horizontal" ? e.clientX : e.clientY;
          const delta = currentPos - startPosRef.current;
          startPosRef.current = currentPos;
          onResize?.(delta);
        };

        const handleMouseUp = () => {
          isDraggingRef.current = false;
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
      },
      [orientation, onResize]
    );

    return (
      <div
        ref={ref}
        data-component="resize-handle"
        data-orientation={orientation}
        className={cn(className)}
        onMouseDown={handleMouseDown}
        {...props}
      >
        <div data-slot="resize-handle-bar" />
      </div>
    );
  }
);

ResizeHandle.displayName = "ResizeHandle";
