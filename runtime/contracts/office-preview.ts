export type OfficePreviewStatus = "starting" | "ready" | "error" | "stopped";

export type OfficePreviewFormat = "docx" | "xlsx" | "pptx" | null;

export type OfficePreviewRef = {
  sessionId: string;
  title: string;
  sourcePath: string;
};

export type OfficePreviewSnapshot = {
  sessionId: string;
  title: string;
  sourcePath: string;
  format: OfficePreviewFormat;
  startedAt: number;
  updatedAt: number;
  status: OfficePreviewStatus;
  html: string;
  error?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

export const isOfficePreviewRef = (value: unknown): value is OfficePreviewRef => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sessionId === "string" &&
    typeof value.title === "string" &&
    typeof value.sourcePath === "string"
  );
};
