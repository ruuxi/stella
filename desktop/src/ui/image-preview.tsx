import * as React from "react";
import { cn } from "@/lib/utils";

export interface ImagePreviewProps extends React.HTMLAttributes<HTMLDivElement> {
  src: string;
  alt?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export const ImagePreview = React.forwardRef<HTMLDivElement, ImagePreviewProps>(
  ({ className, src, alt = "", maxWidth, maxHeight, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-component="image-preview"
        className={cn(className)}
        {...props}
      >
        <img
          src={src}
          alt={alt}
          style={{
            maxWidth: maxWidth ? `${maxWidth}px` : undefined,
            maxHeight: maxHeight ? `${maxHeight}px` : undefined,
          }}
        />
      </div>
    );
  }
);

ImagePreview.displayName = "ImagePreview";
