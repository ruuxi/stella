import { promises as fs } from "fs";
import { ipcMain } from "electron";
import path from "path";

type StoreHandlersOptions = {
  getStellaHomePath: () => string | null;
};

export const registerStoreHandlers = (options: StoreHandlersOptions) => {
  ipcMain.handle("theme:listInstalled", async () => {
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) {
      return [];
    }
    const themesDir = path.join(stellaHomePath, "themes");
    try {
      const files = await fs.readdir(themesDir);
      const themes = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(themesDir, file), "utf-8");
          const theme = JSON.parse(raw);
          if (theme.id && theme.name && theme.light && theme.dark) {
            themes.push(theme);
          }
        } catch {
          // skip invalid theme files
        }
      }
      return themes;
    } catch {
      return [];
    }
  });
};
