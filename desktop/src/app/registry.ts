import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type GeneratedPage = {
  id: string;
  title: string;
  component: LazyExoticComponent<ComponentType>;
};

export const MEDIA_PAGE: GeneratedPage = {
  id: "media",
  title: "Media",
  component: lazy(() => import("./media/MediaStudio")),
};

export const generatedPages: GeneratedPage[] = [];
