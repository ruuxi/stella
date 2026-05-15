/**
 * Drop-up menu offering external apps to open a chat artifact with.
 *
 * Lives on the right edge of `EndResourceCard`. The trigger is a slim
 * pill so it doesn't fight the card's primary "open in panel" click
 * target. The menu prefers opening upward (chat artifacts typically
 * sit near the bottom of the viewport during streaming) but Radix
 * auto-flips to a drop-down when the card is near the top.
 */

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import "./open-with-menu.css";

type Opener = {
  id: string;
  label: string;
  kind: "app" | "default" | "reveal";
};

export const OpenWithMenu = ({ filePath }: { filePath: string }) => {
  const [open, setOpen] = useState(false);
  const [openers, setOpeners] = useState<Opener[] | null>(null);

  useEffect(() => {
    if (!open || openers) return;
    let cancelled = false;
    const api = window.electronAPI?.system;
    if (!api?.listExternalOpeners) {
      setOpeners([]);
      return;
    }
    void api
      .listExternalOpeners(filePath)
      .then((result) => {
        if (cancelled) return;
        setOpeners(result?.openers ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setOpeners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, openers, filePath]);

  const handleSelect = useCallback(
    (openerId: string) => {
      const api = window.electronAPI?.system;
      if (!api?.openWithExternal) return;
      void api.openWithExternal(filePath, openerId);
    },
    [filePath],
  );

  const appOpeners = openers?.filter((entry) => entry.kind === "app") ?? [];
  const builtins = openers?.filter((entry) => entry.kind !== "app") ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="open-with-menu__trigger"
          onClick={(event) => event.stopPropagation()}
          title="Open with…"
        >
          <span className="open-with-menu__trigger-label">Open</span>
          <ChevronDown size={12} strokeWidth={2} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className="open-with-menu"
      >
        {openers === null ? (
          <div className="open-with-menu__loading">Loading…</div>
        ) : (
          <>
            {appOpeners.map((opener) => (
              <DropdownMenuItem
                key={opener.id}
                onSelect={() => handleSelect(opener.id)}
              >
                {opener.label}
              </DropdownMenuItem>
            ))}
            {appOpeners.length > 0 && builtins.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {builtins.map((opener) => (
              <DropdownMenuItem
                key={opener.id}
                onSelect={() => handleSelect(opener.id)}
              >
                {opener.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
