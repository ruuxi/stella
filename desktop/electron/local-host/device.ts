import { promises as fs } from "fs";
import path from "path";

type DeviceRecord = {
  deviceId: string;
};

const DEVICE_FILE = "device.json";

export const getDeviceRecordPath = (userDataPath: string) =>
  path.join(userDataPath, DEVICE_FILE);

export const getOrCreateDeviceId = async (userDataPath: string) => {
  const recordPath = getDeviceRecordPath(userDataPath);
  try {
    const raw = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(raw) as DeviceRecord;
    if (parsed.deviceId) {
      return parsed.deviceId;
    }
  } catch {
    // Fall through to create.
  }

  const deviceId = crypto.randomUUID();
  const payload: DeviceRecord = { deviceId };
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(payload, null, 2), "utf-8");
  return deviceId;
};
