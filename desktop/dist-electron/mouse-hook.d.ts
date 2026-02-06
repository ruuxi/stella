type MouseHookEvents = {
    onModifierDown: () => void;
    onModifierUp: () => void;
    onRadialShow: (x: number, y: number) => void;
    onRadialHide: () => void;
    onMouseMove: (x: number, y: number) => void;
    onMouseUp: (x: number, y: number) => void;
    onLeftClick?: (x: number, y: number) => void;
};
export declare class MouseHookManager {
    private events;
    private radialActive;
    private started;
    private modifierHeld;
    private useNativeBlocking;
    constructor(events: MouseHookEvents);
    private isModifierKey;
    start(): void;
    stop(): void;
    isRadialActive(): boolean;
}
export {};
