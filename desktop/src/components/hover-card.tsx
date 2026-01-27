import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn } from "@/lib/utils";

const HoverCardRoot = HoverCardPrimitive.Root;

const HoverCardTrigger = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <HoverCardPrimitive.Trigger
    ref={ref}
    data-slot="hover-card-trigger"
    className={cn(className)}
    {...props}
  />
));
HoverCardTrigger.displayName = "HoverCardTrigger";

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      data-component="hover-card-content"
      className={cn(className)}
      {...props}
    >
      <div data-slot="hover-card-body">{children}</div>
    </HoverCardPrimitive.Content>
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = "HoverCardContent";

export interface HoverCardProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  openDelay?: number;
  closeDelay?: number;
}

export function HoverCard({
  trigger,
  children,
  side = "bottom",
  align = "center",
  className,
  openDelay = 200,
  closeDelay = 300,
}: HoverCardProps) {
  return (
    <HoverCardRoot openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent side={side} align={align} className={className}>
        {children}
      </HoverCardContent>
    </HoverCardRoot>
  );
}

export { HoverCardRoot, HoverCardTrigger, HoverCardContent };
