import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/ui/switch";
import { NativeSelect } from "@/ui/native-select";
import {
  PREFERRED_MIC_KEY,
  PREFERRED_SPEAKER_KEY,
  MIC_ENABLED_KEY,
  isMicrophoneEnabled,
} from "@/features/voice/services/shared-microphone";

type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export function AudioTab() {
  const platform = window.electronAPI?.platform;
  const [micEnabled, setMicEnabled] = useState(() => isMicrophoneEnabled());
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceInfo[]
  >([]);
  const [selectedMicId, setSelectedMicId] = useState(
    () => localStorage.getItem(PREFERRED_MIC_KEY) ?? "",
  );
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(
    () => localStorage.getItem(PREFERRED_SPEAKER_KEY) ?? "",
  );
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophonePermissionStatus>("unknown");
  const [isResettingMicrophone, setIsResettingMicrophone] = useState(false);

  const syncPermissionStatus = useCallback(async () => {
    const result = await window.electronAPI?.system.getPermissionStatus?.();
    if (result) {
      setMicrophoneStatus(result.microphoneStatus);
    }
    return result ?? null;
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(
        (d) => d.kind === "audioinput" && d.deviceId,
      );
      const outputs = devices.filter(
        (d) => d.kind === "audiooutput" && d.deviceId,
      );
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      setPermissionError(null);
    } catch {
      setPermissionError("Unable to list audio devices.");
    }
  }, []);

  useEffect(() => {
    void syncPermissionStatus();
  }, [syncPermissionStatus]);

  useEffect(() => {
    if (!micEnabled) {
      return;
    }

    // Need at least a transient permission to enumerate labelled devices
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        if (!cancelled) {
          await syncPermissionStatus();
          await loadDevices();
        }
      } catch {
        if (!cancelled) {
          await syncPermissionStatus();
          // Permission denied or no devices — still try enumerateDevices
          await loadDevices();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [micEnabled, loadDevices]);

  const handleMicToggle = useCallback(
    (checked: boolean) => {
      const microphoneDenied =
        platform === "darwin" && microphoneStatus === "denied";

      setMicEnabled(checked);
      localStorage.setItem(MIC_ENABLED_KEY, checked ? "true" : "false");

      if (checked) {
        void (async () => {
          if (microphoneDenied) {
            setPermissionError(
              "Microphone access was denied earlier. Reset it and restart Stella, or open System Settings.",
            );
            setMicEnabled(false);
            localStorage.setItem(MIC_ENABLED_KEY, "false");
            return;
          }

          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            stream.getTracks().forEach((t) => t.stop());
            await syncPermissionStatus();
            await loadDevices();
          } catch {
            const permissionStatus = await syncPermissionStatus();
            setPermissionError(
              permissionStatus?.microphoneStatus === "denied"
                ? "Microphone access was denied earlier. Reset it and restart Stella, or open System Settings."
                : "Microphone access was denied. Please allow it in your system settings.",
            );
            setMicEnabled(false);
            localStorage.setItem(MIC_ENABLED_KEY, "false");
          }
        })();
      }
    },
    [loadDevices, microphoneStatus, platform, syncPermissionStatus],
  );

  const handleMicChange = useCallback((deviceId: string) => {
    setSelectedMicId(deviceId);
    if (deviceId) {
      localStorage.setItem(PREFERRED_MIC_KEY, deviceId);
    } else {
      localStorage.removeItem(PREFERRED_MIC_KEY);
    }
  }, []);

  const handleSpeakerChange = useCallback((deviceId: string) => {
    setSelectedSpeakerId(deviceId);
    if (deviceId) {
      localStorage.setItem(PREFERRED_SPEAKER_KEY, deviceId);
    } else {
      localStorage.removeItem(PREFERRED_SPEAKER_KEY);
    }
  }, []);

  const handleResetMicrophoneAndRestart = useCallback(async () => {
    setIsResettingMicrophone(true);
    try {
      const resetResult =
        await window.electronAPI?.system.resetMicrophonePermission?.();
      if (!resetResult?.ok) {
        setIsResettingMicrophone(false);
        return;
      }
      const quitResult = await window.electronAPI?.system.quitForRestart?.();
      if (!quitResult?.ok) {
        setIsResettingMicrophone(false);
      }
    } catch {
      setIsResettingMicrophone(false);
    }
  }, []);

  const microphoneDenied =
    platform === "darwin" && microphoneStatus === "denied";

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Microphone</h3>
        <p className="settings-card-desc">
          Allow Stella to use your microphone for voice conversations.
        </p>
        {permissionError ? (
          <p className="settings-card-desc settings-card-desc--error" role="alert">
            {permissionError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Enable microphone</div>
            <div className="settings-row-sublabel">
              Voice features require microphone access.
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={micEnabled}
              onCheckedChange={handleMicToggle}
              hideLabel
            />
          </div>
        </div>
        {microphoneDenied ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Recover microphone access</div>
              <div className="settings-row-sublabel">
                macOS will not prompt Stella again automatically after a prior
                denial. Reset the permission, then reopen Stella from the
                launcher.
              </div>
            </div>
            <div className="settings-row-control settings-row-control--stacked">
              <button
                type="button"
                className="settings-btn"
                disabled={isResettingMicrophone}
                onClick={() =>
                  void window.electronAPI?.system.openPermissionSettings?.(
                    "microphone",
                  )
                }
              >
                Open Settings
              </button>
              <button
                type="button"
                className="settings-btn settings-btn--danger"
                disabled={isResettingMicrophone}
                onClick={() => void handleResetMicrophoneAndRestart()}
              >
                {isResettingMicrophone ? "Closing..." : "Reset & Restart"}
              </button>
            </div>
          </div>
        ) : null}
        {micEnabled && audioInputDevices.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Input device</div>
              <div className="settings-row-sublabel">
                Choose which microphone Stella listens on.
              </div>
            </div>
            <div className="settings-row-control">
              <NativeSelect
                className="settings-runtime-select"
                value={selectedMicId}
                onChange={(e) => handleMicChange(e.target.value)}
              >
                <option value="">System default</option>
                {audioInputDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">Speaker</h3>
        <p className="settings-card-desc">
          Choose which speaker Stella uses for voice responses.
        </p>
        {audioOutputDevices.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Output device</div>
              <div className="settings-row-sublabel">
                Audio output for voice conversations.
              </div>
            </div>
            <div className="settings-row-control">
              <NativeSelect
                className="settings-runtime-select"
                value={selectedSpeakerId}
                onChange={(e) => handleSpeakerChange(e.target.value)}
              >
                <option value="">System default</option>
                {audioOutputDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        ) : (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-sublabel">
                {micEnabled
                  ? "No output devices found."
                  : "Enable the microphone to see available audio devices."}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
