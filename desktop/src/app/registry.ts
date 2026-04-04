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

export const HOME_PAGE: GeneratedPage = {
  id: "home",
  title: "Home",
  component: lazy(() => import("./home/Home")),
};

export const generatedPages: GeneratedPage[] = [
  HOME_PAGE,
];
