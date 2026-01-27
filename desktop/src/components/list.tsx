import * as React from "react";
import { cn } from "@/lib/utils";

export interface ListProps extends React.HTMLAttributes<HTMLDivElement> {}

export const List = React.forwardRef<HTMLDivElement, ListProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-component="list"
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
List.displayName = "List";

export interface ListItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  selected?: boolean;
}

export const ListItem = React.forwardRef<HTMLButtonElement, ListItemProps>(
  ({ className, active, selected, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        data-slot="list-item"
        data-active={active || undefined}
        data-selected={selected || undefined}
        className={cn(className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);
ListItem.displayName = "ListItem";

export interface ListHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ListHeader = React.forwardRef<HTMLDivElement, ListHeaderProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="list-header"
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ListHeader.displayName = "ListHeader";

export interface ListGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ListGroup = React.forwardRef<HTMLDivElement, ListGroupProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="list-group"
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ListGroup.displayName = "ListGroup";

export interface ListScrollProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ListScroll = React.forwardRef<HTMLDivElement, ListScrollProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="list-scroll"
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ListScroll.displayName = "ListScroll";

export interface ListItemsProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ListItems = React.forwardRef<HTMLDivElement, ListItemsProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="list-items"
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ListItems.displayName = "ListItems";

export interface ListEmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  message?: string;
}

export const ListEmptyState = React.forwardRef<HTMLDivElement, ListEmptyStateProps>(
  ({ className, message = "No items found", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="list-empty-state"
        className={cn(className)}
        {...props}
      >
        <div data-slot="list-message">{children || message}</div>
      </div>
    );
  }
);
ListEmptyState.displayName = "ListEmptyState";
