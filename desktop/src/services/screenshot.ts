import { getElectronApi } from "./electron";

export type ScreenshotCapture = {
  dataUrl: string;
  width: number;
  height: number;
};

export const captureScreenshot = async (
  point?: { x: number; y: number }
): Promise<ScreenshotCapture | null> => {
  const api = getElectronApi();
  if (!api?.captureScreenshot) {
    return null;
  }
  return await api.captureScreenshot(point);
};
