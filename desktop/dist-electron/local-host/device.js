import { promises as fs } from "fs";
import path from "path";
const DEVICE_FILE = "device.json";
export const getDeviceRecordPath = (statePath) => path.join(statePath, DEVICE_FILE);
export const getOrCreateDeviceId = async (statePath) => {
    const recordPath = getDeviceRecordPath(statePath);
    try {
        const raw = await fs.readFile(recordPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.deviceId) {
            return parsed.deviceId;
        }
    }
    catch {
        // Fall through to create.
    }
    const deviceId = crypto.randomUUID();
    const payload = { deviceId };
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(payload, null, 2), "utf-8");
    return deviceId;
};
