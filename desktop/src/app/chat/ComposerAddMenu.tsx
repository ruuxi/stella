/**
 * ComposerAddMenu — the dropdown that opens from the composer's "+" button.
 *
 * Attachment actions backed by chatContext or the desktop mini-window:
 *   1. Attach files…   → image-aware file picker (matches drag-and-drop).
 *   2. Capture         → radial-dial-style region/window capture.
 *   3. Attach Stella   → pick a window and dock the mini beside it.
 *
 * Menu order (top → bottom): optional recent files, new chat, then capture,
 * select area, attach Stella, and attach files at the bottom (nearest the +
 * button). No dividers between rows.
 *
 * The menu owns its own state (file input ref + recent-files store), so
 * both the home full-chat composer and the sidebar composer can reuse it
 * without threading a `onAdd` callback through the chat-column types.
 */
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import {
  Camera,
  File,
  MessageSquarePlus,
  PanelRight,
  Paperclip,
  Scan,
} from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { showToast } from "@/ui/toast";
import { ComposerAddButton } from "@/features/chat/ComposerPrimitives";
import { getElectronApi } from "@/platform/electron/electron";
import {
  applyProcessedAttachments,
  attachFilesToContext,
} from "@/features/chat/lib/file-attach";
import { useRecentFiles } from "@/features/chat/hooks/use-recent-files";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import type { ComposerContextSuggestion } from "./ComposerContextRow";
import "./composer-add-menu.css";

type ComposerAddMenuProps = {
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  className?: string;
  title?: string;
  onSelectArea?: () => void;
  onNewChat?: () => void | Promise<void>;
  contextSuggestions?: ComposerContextSuggestion[];
  onSelectContextSuggestion?: (suggestion: ComposerContextSuggestion) => void;
};

const FILE_NAME_MAX_DISPLAY = 28;

export const getContextSuggestionLabel = (
  suggestion: ComposerContextSuggestion,
): string => {
  const chip = suggestion.chip;
  return chip.kind === "tab"
    ? chip.title
      ? `${chip.browser} — ${chip.title}`
      : `${chip.browser} — ${chip.host}`
    : chip.windowTitle
      ? `${chip.name} — ${chip.windowTitle}`
      : chip.name;
};

function truncateFileName(
  name: string,
  max: number = FILE_NAME_MAX_DISPLAY,
): string {
  if (name.length <= max) return name;
  const dotIndex = name.lastIndexOf(".");
  // Keep the extension visible when there's a sensible head budget.
  if (dotIndex >= 0 && dotIndex >= max - 4) {
    const ext = name.slice(dotIndex);
    const headBudget = max - 1 - ext.length;
    if (headBudget > 0) {
      return `${name.slice(0, headBudget)}…${ext}`;
    }
  }
  return `${name.slice(0, max - 1)}…`;
}

export function ComposerAddMenu({
  setChatContext,
  className,
  title,
  onSelectArea,
  onNewChat,
  contextSuggestions = [],
  onSelectContextSuggestion,
}: ComposerAddMenuProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newChatArmed, setNewChatArmed] = useState(false);
  const [newChatPending, setNewChatPending] = useState(false);
  const { recentFiles, recordRecentFiles } = useRecentFiles();

  const handleAttachFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      if (!list || list.length === 0) {
        event.target.value = "";
        return;
      }
      const files = Array.from(list);
      const processed = await attachFilesToContext(files, setChatContext);
      // Only non-image attachments are recorded — images come back as
      // chip thumbnails (`regionScreenshots`), and the recents row treats
      // its entries as file badges.
      recordRecentFiles(processed.files);
      event.target.value = "";
    },
    [recordRecentFiles, setChatContext],
  );

  const handleCapture = useCallback(async () => {
    const api = getElectronApi();
    if (!api) return;
    try {
      await api.capture.beginRegionCapture();
    } catch (error) {
      console.warn("[composer-add-menu] capture failed:", error);
    }
  }, []);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (newChatPending) return;
      setMenuOpen(open);
      if (!open) setNewChatArmed(false);
    },
    [newChatPending],
  );

  const handleNewChatSelect = useCallback(
    async (event: Event) => {
      if (!onNewChat) return;
      if (!newChatArmed) {
        event.preventDefault();
        setNewChatArmed(true);
        return;
      }
      setNewChatPending(true);
      try {
        await onNewChat();
        setMenuOpen(false);
        setNewChatArmed(false);
      } catch (error) {
        console.warn("[composer-add-menu] new chat failed:", error);
        showToast({
          title: "Couldn’t start a new chat",
          description:
            error instanceof Error && error.message
              ? error.message
              : "Stella will keep this chat open.",
          variant: "error",
        });
      } finally {
        setNewChatPending(false);
      }
    },
    [newChatArmed, onNewChat],
  );

  const handleSelectArea = useCallback(() => {
    setMenuOpen(false);
    onSelectArea?.();
  }, [onSelectArea]);

  const handleAttachWindow = useCallback(async () => {
    const api = getElectronApi();
    if (!api) return;
    setMenuOpen(false);
    try {
      const result = await api.capture.beginWindowAttach();
      if ("cancelled" in result || result.ok) {
        return;
      }
      showToast({
        title: "Couldn’t attach Stella",
        description: result.message,
        variant: "error",
      });
    } catch (error) {
      console.warn("[composer-add-menu] attach failed:", error);
      showToast({
        title: "Couldn’t attach Stella",
        description:
          error instanceof Error && error.message
            ? error.message
            : "Try a normal app window.",
        variant: "error",
      });
    }
  }, []);

  const handleRecentClick = useCallback(
    (file: ChatContextFile) => {
      applyProcessedAttachments(
        { screenshots: [], files: [file] },
        setChatContext,
      );
    },
    [setChatContext],
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <ComposerAddButton className={className} title={title ?? "Add"} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={6}
          className="composer-add-menu"
        >
          {recentFiles.length > 0 && (
            <>
              <DropdownMenuLabel>Recent</DropdownMenuLabel>
              {recentFiles.map((file) => (
                <DropdownMenuItem
                  key={`${file.name}::${file.size}`}
                  className="composer-add-menu__recent-item"
                  onSelect={() => handleRecentClick(file)}
                >
                  <span data-slot="dropdown-menu-item-icon">
                    <FileGlyphIcon />
                  </span>
                  <span
                    className="composer-add-menu__recent-name"
                    title={file.name}
                  >
                    {truncateFileName(file.name)}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          {contextSuggestions.length > 0 ? (
            <>
              <DropdownMenuLabel>Context</DropdownMenuLabel>
              {contextSuggestions.map((suggestion) => {
                const label = getContextSuggestionLabel(suggestion);
                return (
                  <DropdownMenuItem
                    key={suggestion.key}
                    onSelect={() => onSelectContextSuggestion?.(suggestion)}
                  >
                    <span data-slot="dropdown-menu-item-icon">
                      <ContextSuggestionIcon suggestion={suggestion} />
                    </span>
                    <span
                      className="composer-add-menu__context-name"
                      title={label}
                    >
                      {label}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </>
          ) : null}
          {onNewChat ? (
            <DropdownMenuItem
              onSelect={(event) => {
                void handleNewChatSelect(event);
              }}
            >
              <span data-slot="dropdown-menu-item-icon">
                <MessageSquarePlus size={16} strokeWidth={1.75} />
              </span>
              {newChatArmed ? "Confirm new chat" : "New chat"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={handleCapture}>
            <span data-slot="dropdown-menu-item-icon">
              <Camera size={16} strokeWidth={1.75} />
            </span>
            Capture
          </DropdownMenuItem>
          {onSelectArea ? (
            <DropdownMenuItem onSelect={handleSelectArea}>
              <span data-slot="dropdown-menu-item-icon">
                <Scan size={16} strokeWidth={1.75} />
              </span>
              Select area
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={handleAttachWindow}>
            <span data-slot="dropdown-menu-item-icon">
              <PanelRight size={16} strokeWidth={1.75} />
            </span>
            Attach Stella
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAttachFiles}>
            <span data-slot="dropdown-menu-item-icon">
              <Paperclip size={16} strokeWidth={1.75} />
            </span>
            Attach files…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="composer-add-menu__file-input"
        onChange={handleFilesSelected}
      />
    </>
  );
}

function FileGlyphIcon() {
  return <File size={16} strokeWidth={1.75} aria-hidden />;
}

function ContextSuggestionIcon({
  suggestion,
}: {
  suggestion: ComposerContextSuggestion;
}) {
  const chip = suggestion.chip;
  const label = chip.kind === "tab" ? chip.browser : chip.name;
  if (chip.iconDataUrl) {
    return (
      <img
        src={chip.iconDataUrl}
        alt=""
        aria-hidden="true"
        className="composer-add-menu__context-icon"
        draggable={false}
      />
    );
  }
  return (
    <span className="composer-add-menu__context-fallback" aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
