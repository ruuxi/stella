export type DeviceIdentity = {
    deviceId: string;
    publicKey: string;
    privateKey: string;
};
export declare const getDeviceRecordPath: (statePath: string) => string;
export declare const getOrCreateDeviceId: (statePath: string) => Promise<string>;
export declare const getOrCreateDeviceIdentity: (statePath: string) => Promise<DeviceIdentity>;
export declare const signDeviceHeartbeat: (identity: DeviceIdentity, signedAtMs: number) => string;
