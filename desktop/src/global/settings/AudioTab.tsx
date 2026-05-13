import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/ui/switch";
import { Select } from "@/ui/select";
import {
  PREFERRED_MIC_KEY,
  PREFERRED_SPEAKER_KEY,
  MIC_ENABLED_KEY,
  isMicrophoneEnabled,
} from "@/features/voice/services/shared-microphone";
import {
  isDictationEnhanceEnabled,
  isDictationSuperFastEnabled,
  isLocalDictationEnabled,
  setDictationEnhancePreference,
  setDictationSuperFastModeEnabled,
  setDictationSuperFastPreference,
  setLocalDictationPreference,
} from "@/features/dictation/services/inworld-dictation";
import { useMicrophoneRecovery } from "@/global/permissions/use-microphone-recovery";
import { requestBrowserMicrophoneAccess } from "@/global/permissions/microphone-permission";

type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export function AudioTab() {
  const platform = window.electronAPI?.platform;
  const arch = window.electronAPI?.arch;
  const localDictationSupported = platform === "darwin" && arch === "arm64";
  const [localDictationUnavailableReason, setLocalDictationUnavailableReason] =
    useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(() => isMicrophoneEnabled());
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [dictationSuperFast, setDictationSuperFast] = useState(() =>
    isDictationSuperFastEnabled(),
  );
  const [enhanceDictation, setEnhanceDictation] = useState(() =>
    isDictationEnhanceEnabled(),
  );
  const [dictationSoundEffects, setDictationSoundEffects] = useState(true);
  const [savingDictationSoundEffects, setSavingDictationSoundEffects] =
    useState(false);
  const [localDictation, setLocalDictation] = useState(() =>
    isLocalDictationEnabled(),
  );
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
  const microphoneRecovery = useMicrophoneRecovery();

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
    let cancelled = false;
    void window.electronAPI?.system
      ?.getWakeWordEnabled?.()
      .then((enabled) => {
        if (!cancelled) setWakeWordEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleWakeWordToggle = useCallback((checked: boolean) => {
    setWakeWordEnabled(checked);
    void window.electronAPI?.system?.setWakeWordEnabled?.(checked).catch(() => {
      setWakeWordEnabled(!checked);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.dictation
      ?.getSoundEffectsEnabled?.()
      .then((enabled) => {
        if (!cancelled) setDictationSoundEffects(enabled !== false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!micEnabled) {
      return;
    }

    let cancelled = false;
    void (async () => {
      await syncPermissionStatus();
      if (!cancelled) {
        await loadDevices();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [micEnabled, loadDevices, syncPermissionStatus]);

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
            await requestBrowserMicrophoneAccess();
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

  const handleDictationSuperFastToggle = useCallback((checked: boolean) => {
    setDictationSuperFast(checked);
    setDictationSuperFastPreference(checked);
    void setDictationSuperFastModeEnabled(checked).catch((error: Error) => {
      setPermissionError(error.message);
      setDictationSuperFast(false);
      setDictationSuperFastPreference(false);
    });
  }, []);

  const handleEnhanceDictationToggle = useCallback((checked: boolean) => {
    setEnhanceDictation(checked);
    setDictationEnhancePreference(checked);
  }, []);

  const handleLocalDictationToggle = useCallback((checked: boolean) => {
    setLocalDictation(checked);
    setLocalDictationPreference(checked);
  }, []);

  const handleDictationSoundEffectsToggle = useCallback((checked: boolean) => {
    const previous = dictationSoundEffects;
    setDictationSoundEffects(checked);
    setSavingDictationSoundEffects(true);
    void window.electronAPI?.dictation
      ?.setSoundEffectsEnabled?.(checked)
      .then((result) => {
        setDictationSoundEffects(result.enabled);
      })
      .catch(() => {
        setDictationSoundEffects(previous);
      })
      .finally(() => {
        setSavingDictationSoundEffects(false);
      });
  }, [dictationSoundEffects]);

  useEffect(() => {
    if (!localDictationSupported) return;
    let cancelled = false;
    void window.electronAPI?.dictation
      ?.localStatus?.()
      .then((status) => {
        if (cancelled) return;
        setLocalDictationUnavailableReason(
          status.available
            ? null
            : (status.reason ?? "Unavailable on this Mac."),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [localDictationSupported]);

  useEffect(() => {
    if (!micEnabled && dictationSuperFast) {
      handleDictationSuperFastToggle(false);
      return;
    }
    if (micEnabled && dictationSuperFast) {
      void setDictationSuperFastModeEnabled(true).catch(() => undefined);
    }
  }, [dictationSuperFast, handleDictationSuperFastToggle, micEnabled]);

  useEffect(() => {
    if (!micEnabled && wakeWordEnabled) {
      handleWakeWordToggle(false);
    }
  }, [micEnabled, wakeWordEnabled, handleWakeWordToggle]);

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

  const microphoneDenied =
    platform === "darwin" && microphoneStatus === "denied";
  const showMicrophoneRecovery = platform === "darwin";
  const microphoneRecoveryLabel = microphoneDenied
    ? "Recover microphone access"
    : "Manage microphone access";
  const microphoneRecoveryDescription = microphoneDenied
    ? "Once you've said no, macOS won't ask again on its own. Reset the permission, then quit and reopen Stella."
    : "If the microphone permission ever gets stuck, you can reset it and ask macOS to prompt again.";

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Microphone</h3>
        {permissionError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {permissionError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Enable microphone</div>
            <div className="settings-row-sublabel">
              Required for talking to Stella.
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
        {showMicrophoneRecovery ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">
                {microphoneRecoveryLabel}
              </div>
              <div className="settings-row-sublabel">
                {microphoneRecoveryDescription}
              </div>
            </div>
            <div className="settings-row-control settings-row-control--stacked">
              <button
                type="button"
                className="settings-btn"
                disabled={microphoneRecovery.isResetting}
                onClick={microphoneRecovery.openSettings}
              >
                Open Settings
              </button>
              <button
                type="button"
                className="settings-btn settings-btn--danger"
                disabled={microphoneRecovery.isResetting}
                onClick={() => void microphoneRecovery.resetAndRestart()}
              >
                {microphoneRecovery.isResetting
                  ? "Closing..."
                  : "Reset & Restart"}
              </button>
            </div>
          </div>
        ) : null}
        {micEnabled ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Hey Stella wake word</div>
              <div className="settings-row-sublabel">
                Listen for "Hey Stella" in the background and start a voice
                conversation. When off, mic stays idle until you press dictate.
              </div>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={wakeWordEnabled}
                onCheckedChange={handleWakeWordToggle}
                hideLabel
              />
            </div>
          </div>
        ) : null}
        {micEnabled && audioInputDevices.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Microphone</div>
              <div className="settings-row-sublabel">
                Which mic should Stella listen to?
              </div>
            </div>
            <div className="settings-row-control">
              <Select
                className="settings-runtime-select"
                value={selectedMicId}
                onValueChange={(value) => handleMicChange(value)}
                aria-label="Microphone"
                options={[
                  { value: "", label: "System default" },
                  ...audioInputDevices.map((device, index) => ({
                    value: device.deviceId,
                    label: device.label || `Microphone ${index + 1}`,
                  })),
                ]}
              />
            </div>
          </div>
        ) : null}
        {micEnabled ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Super Fast dictation</div>
              <div className="settings-row-sublabel">
                Keep the microphone warm so dictation starts with less delay.
              </div>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={dictationSuperFast}
                onCheckedChange={handleDictationSuperFastToggle}
                hideLabel
              />
            </div>
          </div>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Dictation sounds</div>
            <div className="settings-row-sublabel">
              Play a sound when dictation starts and stops.
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={dictationSoundEffects}
              disabled={savingDictationSoundEffects}
              onCheckedChange={(checked) =>
                handleDictationSoundEffectsToggle(Boolean(checked))
              }
              hideLabel
            />
          </div>
        </div>
        {micEnabled ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Enhance transcription</div>
              <div className="settings-row-sublabel">
                Clean up local dictation text with Mercury before inserting
                it.
              </div>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={enhanceDictation}
                onCheckedChange={handleEnhanceDictationToggle}
                hideLabel
              />
            </div>
          </div>
        ) : null}
        {localDictationSupported && micEnabled ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">On-device transcription</div>
              <div className="settings-row-sublabel">
                {localDictationUnavailableReason ??
                  "Use the local Parakeet model instead of Inworld. This can use more memory on lower-end Macs."}
              </div>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={localDictation && !localDictationUnavailableReason}
                onCheckedChange={handleLocalDictationToggle}
                disabled={Boolean(localDictationUnavailableReason)}
                hideLabel
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">Speaker</h3>
        {audioOutputDevices.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Output device</div>
              <div className="settings-row-sublabel">
                Pick the speaker or headphones to use.
              </div>
            </div>
            <div className="settings-row-control">
              <Select
                className="settings-runtime-select"
                value={selectedSpeakerId}
                onValueChange={(value) => handleSpeakerChange(value)}
                aria-label="Output device"
                options={[
                  { value: "", label: "System default" },
                  ...audioOutputDevices.map((device, index) => ({
                    value: device.deviceId,
                    label: device.label || `Speaker ${index + 1}`,
                  })),
                ]}
              />
            </div>
          </div>
        ) : (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-sublabel">
                {micEnabled
                  ? "No speakers found."
                  : "Turn on the microphone to see your speakers."}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
