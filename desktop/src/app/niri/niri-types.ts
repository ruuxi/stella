export type NiriWindowType =
  | "news-feed"
  | "music-player"
  | "ai-search"
  | "calendar"
  | "game"
  | "system-monitor"
  | "weather"
  | "notes"
  | "file-browser";

export interface NiriWindow {
  id: string;
  type: NiriWindowType;
  title: string;
  width: number; // column width in px
  height: number; // -1 means fill available height
}

export interface NiriColumn {
  id: string;
  windows: NiriWindow[];
}

export interface NiriWorkspace {
  id: string;
  columns: NiriColumn[];
  focusedColumnIndex: number;
  scrollX: number; // current scroll offset
}

export interface NiriState {
  workspaces: NiriWorkspace[];
  activeWorkspaceIndex: number;
}

export const WINDOW_TEMPLATES: Record<NiriWindowType, { title: string; width: number }> = {
  "news-feed": { title: "News Feed", width: 420 },
  "music-player": { title: "Music", width: 360 },
  "ai-search": { title: "AI Search", width: 520 },
  "calendar": { title: "Calendar", width: 460 },
  "game": { title: "Asteroid Field", width: 480 },
  "system-monitor": { title: "System Monitor", width: 380 },
  "weather": { title: "Weather", width: 340 },
  "notes": { title: "Notes", width: 400 },
  "file-browser": { title: "Files", width: 380 },
};
