import type { App } from "electron";
export type StellaHome = {
    homePath: string;
    agentsPath: string;
    skillsPath: string;
    pluginsPath: string;
    statePath: string;
    logsPath: string;
};
export declare const resolveStellaHome: (app: App) => Promise<StellaHome>;
