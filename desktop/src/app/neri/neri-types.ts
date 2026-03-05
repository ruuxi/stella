export type NeriWindowType =
  | "news-feed"
  | "music-player"
  | "ai-search"
  | "calendar"
  | "game"
  | "system-monitor"
  | "weather"
  | "notes"
  | "file-browser"
  | "search"
  | "canvas";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface NeriWindow {
  id: string;
  type: NeriWindowType;
  title: string;
  width: number; // column width in px
  searchResults?: SearchResult[];
  canvasHtml?: string;
}

export interface NeriColumn {
  id: string;
  windows: NeriWindow[];
}

export interface NeriWorkspace {
  id: string;
  columns: NeriColumn[];
  focusedColumnIndex: number;
}

export interface NeriState {
  workspaces: NeriWorkspace[];
  activeWorkspaceIndex: number;
}

export const WINDOW_TEMPLATES: Record<NeriWindowType, { title: string; width: number }> = {
  "news-feed": { title: "News Feed", width: 420 },
  "music-player": { title: "Music", width: 360 },
  "ai-search": { title: "AI Search", width: 520 },
  "calendar": { title: "Calendar", width: 460 },
  "game": { title: "Asteroid Field", width: 480 },
  "system-monitor": { title: "System Monitor", width: 380 },
  "weather": { title: "Weather", width: 340 },
  "notes": { title: "Notes", width: 400 },
  "file-browser": { title: "Files", width: 380 },
  "search": { title: "Search", width: 520 },
  "canvas": { title: "Canvas", width: 600 },
};
