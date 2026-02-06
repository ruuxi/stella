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
export declare const captureChatContext: (_point: {
    x: number;
    y: number;
}) => Promise<ChatContext>;
