import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type GeneratedPage = {
  id: string;
  title: string;
  component: LazyExoticComponent<ComponentType>;
};

export const generatedPages: GeneratedPage[] = [
];
