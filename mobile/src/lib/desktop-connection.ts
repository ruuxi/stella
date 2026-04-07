import {
  getPreferredPhoneAccess,
  getDesktopBridgeStatus,
  requestDesktopConnection,
} from "./phone-access";

type DesktopState = "disconnected" | "connecting" | "connected";
type Listener = (state: DesktopState) => void;

let currentState: DesktopState = "disconnected";
const listeners = new Set<Listener>();

export function getDesktopConnectionState(): DesktopState {
  return currentState;
}

function setState(next: DesktopState) {
  if (next === currentState) return;
  currentState = next;
  for (const fn of listeners) fn(next);
}

export function subscribeDesktopConnection(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function checkDesktopConnection() {
  try {
    const access = await getPreferredPhoneAccess();
    if (!access) { setState("disconnected"); return; }
    const status = await getDesktopBridgeStatus(access.desktopDeviceId);
    setState(status.available ? "connected" : "disconnected");
  } catch {
    setState("disconnected");
  }
}

export async function connectToDesktop() {
  setState("connecting");
  try {
    const access = await getPreferredPhoneAccess();
    if (!access) { setState("disconnected"); return; }
    await requestDesktopConnection(access);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const status = await getDesktopBridgeStatus(access.desktopDeviceId);
      if (status.available) { setState("connected"); return; }
    }
    setState("disconnected");
  } catch {
    setState("disconnected");
  }
}
