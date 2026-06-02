import type { Theme, ThemeColors } from "./types";

export type { Theme, ThemeColors };

type ThemeModule = { default?: Theme };
type ThemeRegistryHotData = {
  initialized?: boolean;
  listeners?: Set<() => void>;
  registeredThemes?: Map<string, Theme>;
};

const themeModules = import.meta.glob<ThemeModule>("./*.ts", { eager: true });
const hotData = (import.meta.hot?.data ?? {}) as ThemeRegistryHotData;

const listeners = hotData.listeners ?? new Set<() => void>();
const registeredThemes = hotData.registeredThemes ?? new Map<string, Theme>();
if (import.meta.hot) {
  hotData.listeners = listeners;
  hotData.registeredThemes = registeredThemes;
}

const isRegistrySupportModule = (modulePath: string) =>
  modulePath.endsWith("/index.ts") || modulePath.endsWith("/types.ts");

const readBuiltinThemes = (): Theme[] =>
  Object.entries(themeModules)
    .filter(([modulePath]) => !isRegistrySupportModule(modulePath))
    .map(([, module]) => module.default)
    .filter((theme): theme is Theme => Boolean(theme?.id && theme.name));

const buildThemesSnapshot = (): readonly Theme[] => {
  const byId = new Map<string, Theme>();
  for (const theme of readBuiltinThemes()) {
    byId.set(theme.id, theme);
  }
  for (const theme of registeredThemes.values()) {
    byId.set(theme.id, theme);
  }
  return Array.from(byId.values());
};

let themesSnapshot: readonly Theme[] = buildThemesSnapshot();

const refreshThemesSnapshot = () => {
  themesSnapshot = buildThemesSnapshot();
};

const emitChange = () => {
  refreshThemesSnapshot();
  for (const listener of listeners) {
    listener();
  }
};

export const getThemeById = (id: string): Theme | undefined => {
  return themesSnapshot.find((t) => t.id === id);
};

export const defaultTheme = getThemeById("pearl") ?? themesSnapshot[0]!;

export const subscribeThemes = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getThemesSnapshot = (): readonly Theme[] => themesSnapshot;

export const registerTheme = (theme: Theme) => {
  registeredThemes.set(theme.id, theme);
  emitChange();
};

if (import.meta.hot) {
  const shouldNotifyAfterHotUpdate = hotData.initialized === true;
  hotData.initialized = true;
  import.meta.hot.accept(() => {
    emitChange();
  });
  if (shouldNotifyAfterHotUpdate) {
    queueMicrotask(emitChange);
  }
}
