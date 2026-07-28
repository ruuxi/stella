import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Search } from "@/ui/icons";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { radialSearchStore, useRadialSearchOpen } from "./radial-search-store";
import "./radial-search-overlay.css";

export function RadialSearchOverlay() {
  const open = useRadialSearchOpen();
  const [inputValue, setInputValue] = useState("");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    setInputValue("");
    setQuery("");
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(inputValue), 150);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) radialSearchStore.close();
      }}
    >
      <DialogContent
        fit
        size="lg"
        className="radial-search-dialog"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search Stella</DialogTitle>
        <div className="radial-search-dialog__field">
          <Search size={17} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            className="radial-search-dialog__input"
            value={inputValue}
            placeholder="Search activity, files, and more"
            onChange={(event) => setInputValue(event.currentTarget.value)}
            aria-label="Search activity, files, and more"
          />
        </div>

        {searching ? (
          <div className="radial-search-dialog__results">
            <WorkspaceSections
              query={query}
              variant="overview"
              searchMode="quick"
              includeUserApps
              onNavigate={() => radialSearchStore.close()}
              renderEmpty={() => (
                <div className="radial-search-dialog__empty">
                  Nothing matches that search.
                </div>
              )}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
