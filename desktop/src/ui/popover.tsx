import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/shared/lib/utils";
import { NativeWebsiteOverlayRegistrar } from "@/shared/lib/native-website-overlay";

const PopoverRoot = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 4, children, style, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <NativeWebsiteOverlayRegistrar />
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      data-component="popover-content"
      className={cn(className)}
      style={{ ...style, zIndex: 9999 }}
      {...props}
    >
      {children}
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";

const PopoverBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} data-slot="popover-body" className={cn(className)} {...props} />
));
PopoverBody.displayName = "PopoverBody";

export const Popover = Object.assign(PopoverRoot, {
  Trigger: PopoverTrigger,
  Content: PopoverContent,
  Body: PopoverBody,
});

export {
  PopoverTrigger,
  PopoverContent,
  PopoverBody,
};
