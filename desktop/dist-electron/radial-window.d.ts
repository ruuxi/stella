import { BrowserWindow } from 'electron';
export declare const createRadialWindow: () => BrowserWindow;
export declare const showRadialWindow: (x: number, y: number) => void;
export declare const hideRadialWindow: () => void;
export declare const updateRadialCursor: (x: number, y: number) => void;
export declare const getRadialWindow: () => BrowserWindow | null;
export declare const RADIAL_WEDGES: readonly ["capture", "chat", "full", "voice", "auto"];
export type RadialWedge = (typeof RADIAL_WEDGES)[number] | 'dismiss';
export declare const calculateSelectedWedge: (cursorX: number, cursorY: number, centerX: number, centerY: number) => RadialWedge;
