export type WindowBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type ChatContext = {
    window: {
        title: string;
        app: string;
        bounds: WindowBounds;
    } | null;
    browserUrl?: string | null;
    selectedText?: string | null;
    regionScreenshots?: {
        dataUrl: string;
        width: number;
        height: number;
    }[];
    capturePending?: boolean;
};
type CaptureChatContextOptions = {
    excludeCurrentProcessWindows?: boolean;
};
export declare const captureChatContext: (point: {
    x: number;
    y: number;
}, options?: CaptureChatContextOptions) => Promise<ChatContext>;
export {};
