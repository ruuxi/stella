export type PersonalizedDashboardPageStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed";

export type PersonalizedDashboardPage = {
  pageId: string;
  panelName: string;
  title: string;
  status: PersonalizedDashboardPageStatus;
  order: number;
  statusText?: string;
  lastError?: string;
};

export type PersonalizedDashboardPageList = {
  pages: PersonalizedDashboardPage[];
  hasRunning: boolean;
};
