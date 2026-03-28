import { PREFERRED_MIC_KEY } from "@/features/voice/services/shared-microphone";
import { OnboardingReveal } from "./OnboardingReveal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

type VoicePhaseProps = {
  audioInputDevices: MediaDeviceInfo[];
  platform: string;
  selectedMicId: string | null;
  splitTransitionActive: boolean;
  voicePermissionGranted: boolean | null;
  onContinue: () => void;
  onRequestMicrophone: () => void;
  onSelectMic: (deviceId: string) => void;
};

export function OnboardingVoicePhase({
  audioInputDevices,
  platform,
  selectedMicId,
  splitTransitionActive,
  voicePermissionGranted,
  onContinue,
  onRequestMicrophone,
  onSelectMic,
}: VoicePhaseProps) {
  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Voice Interaction</div>
      <p className="onboarding-step-desc">
        Talk to me directly using voice conversations. Just activate the
        shortcut and start speaking naturally.
      </p>

      <div className="onboarding-voice-demo onboarding-pill-stagger">
        <button className="onboarding-pill" onClick={onRequestMicrophone}>
          {voicePermissionGranted === true
            ? "Microphone access granted \u2713"
            : voicePermissionGranted === false
              ? "Microphone access denied"
              : "Allow microphone access"}
        </button>
      </div>

      <OnboardingReveal
        visible={voicePermissionGranted === true && audioInputDevices.length > 1}
        className="onboarding-mic-reveal"
        innerClassName="onboarding-mic-reveal-inner"
      >
        <div className="onboarding-step-label">Microphone</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="onboarding-mic-trigger">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              <span className="onboarding-mic-trigger-label">
                {audioInputDevices.find((device) => device.deviceId === selectedMicId)
                  ?.label || "Select microphone"}
              </span>
              <svg
                className="onboarding-mic-trigger-chevron"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" sideOffset={6}>
            {audioInputDevices.map((device, index) => (
              <DropdownMenuItem
                key={device.deviceId}
                onClick={() => {
                  onSelectMic(device.deviceId);
                  localStorage.setItem(PREFERRED_MIC_KEY, device.deviceId);
                }}
              >
                {selectedMicId === device.deviceId && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
                {device.label || `Microphone ${index + 1}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </OnboardingReveal>

      <div className="onboarding-step-label" style={{ marginTop: 24 }}>
        Voice Shortcut
      </div>
      <p className="onboarding-step-desc">
        Press this shortcut anywhere to start or stop a voice conversation.
        (You can also use the Voice button in the Radial Dial).
      </p>
      <div className="onboarding-shortcut-config onboarding-pill-stagger">
        <div
          className="onboarding-pill"
          style={{ cursor: "default", opacity: 0.8 }}
        >
          {platform === "darwin" ? "Cmd+Shift+D" : "Ctrl+Shift+D"}
        </div>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
