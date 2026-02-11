import type { App } from "electron";
export type StellaHome = {
    homePath: string;
    agentsPath: string;
    skillsPath: string;
    statePath: string;
    logsPath: string;
    canvasPath: string;
};
export declare const resolveStellaHome: (app: App) => Promise<StellaHome>;
