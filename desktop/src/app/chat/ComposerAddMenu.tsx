/**
 * ComposerAddMenu — the dropdown that opens from the composer's "+" button.
 *
 * Attachment actions backed by chatContext or the desktop mini-window:
 *   1. Attach files…   → image-aware file picker (matches drag-and-drop).
 *   2. Capture         → radial-dial-style region/window capture.
 *   3. Select area     → region select overlay.
 *   4. Attach Stella   → pick a window and dock the mini beside it.
 *
 * Menu order (top → bottom): read-aloud, model, optional recent files,
 * then new chat → select area → capture → attach files at the bottom
 * (nearest the + button). No dividers between rows.
 *
 * The menu owns its own state (file input ref + recent-files store), so
 * both the home full-chat composer and the sidebar composer can reuse it
 * without threading a `onAdd` callback through the chat-column types.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import {
  Camera,
  MessageSquarePlus,
  PanelRight,
  Paperclip,
  Scan,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  readAloudPrefStore,
  setReadAloudEnabled as persistReadAloudEnabled,
} from "@/features/voice/services/read-aloud/read-aloud-pref";
import { stopReadAloud } from "@/features/voice/services/read-aloud/read-aloud-player";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { showToast } from "@/ui/toast";
import { ComposerAddButton } from "./ComposerPrimitives";
import { ComposerModelMenuItem } from "./ComposerModelMenuItem";
import { getElectronApi } from "@/platform/electron/electron";
import {
  applyProcessedAttachments,
  attachFilesToContext,
} from "@/app/chat/lib/file-attach";
import { useRecentFiles } from "@/app/chat/hooks/use-recent-files";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";
import "./composer-add-menu.css";

type ComposerAddMenuProps = {
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  onSelectArea: () => void;
  onNewChat?: () => void | Promise<void>;
  className?: string;
  title?: string;
};

const FILE_NAME_MAX_DISPLAY = 28;

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
  onSelectArea,
  onNewChat,
  className,
  title,
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

  const readAloudEnabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );

  const handleToggleReadAloud = useCallback(() => {
    const next = !readAloudEnabled;
    void persistReadAloudEnabled(next);
    if (!next) stopReadAloud();
  }, [readAloudEnabled]);

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
          <DropdownMenuItem onSelect={handleToggleReadAloud}>
            <span data-slot="dropdown-menu-item-icon">
              {readAloudEnabled ? (
                <Volume2 size={14} strokeWidth={1.75} />
              ) : (
                <VolumeX size={14} strokeWidth={1.75} />
              )}
            </span>
            {readAloudEnabled ? "Stop reading aloud" : "Read replies aloud"}
          </DropdownMenuItem>
          <ComposerModelMenuItem />
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
          {onNewChat ? (
            <DropdownMenuItem
              onSelect={(event) => {
                void handleNewChatSelect(event);
              }}
            >
              <span data-slot="dropdown-menu-item-icon">
                <MessageSquarePlus size={14} strokeWidth={1.75} />
              </span>
              {newChatArmed ? "Confirm new chat" : "New chat"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onSelectArea}>
            <span data-slot="dropdown-menu-item-icon">
              <Scan size={14} strokeWidth={1.75} />
            </span>
            Select area
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleCapture}>
            <span data-slot="dropdown-menu-item-icon">
              <Camera size={14} strokeWidth={1.75} />
            </span>
            Capture
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAttachWindow}>
            <span data-slot="dropdown-menu-item-icon">
              <PanelRight size={14} strokeWidth={1.75} />
            </span>
            Attach Stella
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAttachFiles}>
            <span data-slot="dropdown-menu-item-icon">
              <Paperclip size={14} strokeWidth={1.75} />
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
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </svg>
  );
}
