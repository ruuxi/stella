const SHARED_MIC_STATE_KEY = "__stellaSharedMicrophoneState";
const SHARED_MIC_RELEASE_GRACE_MS = 45_000;

export const PREFERRED_MIC_KEY = "stella-preferred-mic-id";
export const PREFERRED_SPEAKER_KEY = "stella-preferred-speaker-id";
export const MIC_ENABLED_KEY = "stella-mic-enabled";

// All renderer voice features intentionally share one speech-capture profile
// so browser/OS echo cancellation is configured consistently everywhere.
const SHARED_MIC_SPEECH_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface SharedMicrophoneLease {
  stream: MediaStream;
  release: () => void;
}

type SharedMicrophoneState = {
  rootStream: MediaStream | null;
  acquirePromise: Promise<MediaStream> | null;
  activeLeaseCount: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  keepWarm: boolean;
};

const getSharedMicrophoneState = (): SharedMicrophoneState => {
  const root = globalThis as typeof globalThis & {
    [SHARED_MIC_STATE_KEY]?: SharedMicrophoneState;
  };

  if (!root[SHARED_MIC_STATE_KEY]) {
    root[SHARED_MIC_STATE_KEY] = {
      rootStream: null,
      acquirePromise: null,
      activeLeaseCount: 0,
      releaseTimer: null,
      keepWarm: false,
    };
  }

  return root[SHARED_MIC_STATE_KEY];
};

const clearReleaseTimer = (state: SharedMicrophoneState) => {
  if (state.releaseTimer) {
    clearTimeout(state.releaseTimer);
    state.releaseTimer = null;
  }
};

const stopStream = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop());
};

const hasLiveTrack = (stream: MediaStream | null) => {
  return (
    stream?.getTracks().some((track) => track.readyState !== "ended") ?? false
  );
};

const getSharedMicrophoneConstraints = (): MediaTrackConstraints => {
  const constraints = { ...SHARED_MIC_SPEECH_CAPTURE_CONSTRAINTS };
  const preferredId = localStorage.getItem(PREFERRED_MIC_KEY);
  if (preferredId) {
    constraints.deviceId = { ideal: preferredId };
  }
  return constraints;
};

const scheduleRootRelease = (state: SharedMicrophoneState) => {
  clearReleaseTimer(state);
  if (state.keepWarm) {
    return;
  }
  state.releaseTimer = setTimeout(() => {
    if (state.activeLeaseCount > 0) {
      return;
    }
    if (state.keepWarm) {
      return;
    }
    stopStream(state.rootStream);
    state.rootStream = null;
    state.releaseTimer = null;
  }, SHARED_MIC_RELEASE_GRACE_MS);
};

const acquireRootStream = async (
  state: SharedMicrophoneState,
): Promise<MediaStream> => {
  if (state.rootStream && hasLiveTrack(state.rootStream)) {
    return state.rootStream;
  }

  if (state.rootStream) {
    stopStream(state.rootStream);
    state.rootStream = null;
  }

  if (!state.acquirePromise) {
    state.acquirePromise = navigator.mediaDevices
      .getUserMedia({ audio: getSharedMicrophoneConstraints() })
      .then((stream) => {
        state.rootStream = stream;
        return stream;
      })
      .catch((err) => {
        state.rootStream = null;
        throw err;
      })
      .finally(() => {
        state.acquirePromise = null;
      });
  }

  return state.acquirePromise;
};

export function isMicrophoneEnabled(): boolean {
  return localStorage.getItem(MIC_ENABLED_KEY) !== "false";
}

export async function acquireSharedMicrophone(): Promise<SharedMicrophoneLease> {
  if (!isMicrophoneEnabled()) {
    throw new Error("Microphone access is disabled in settings.");
  }

  const state = getSharedMicrophoneState();
  clearReleaseTimer(state);

  const rootStream = await acquireRootStream(state);
  state.activeLeaseCount += 1;

  const stream = rootStream.clone();
  let released = false;

  return {
    stream,
    release() {
      if (released) {
        return;
      }
      released = true;

      stopStream(stream);
      state.activeLeaseCount = Math.max(0, state.activeLeaseCount - 1);
      if (state.activeLeaseCount === 0) {
        scheduleRootRelease(state);
      }
    },
  };
}

export async function setSharedMicrophoneKeepWarm(
  keepWarm: boolean,
): Promise<void> {
  const state = getSharedMicrophoneState();
  state.keepWarm = keepWarm;
  if (keepWarm) {
    clearReleaseTimer(state);
    await acquireRootStream(state);
    return;
  }
  if (state.activeLeaseCount === 0) {
    scheduleRootRelease(state);
  }
}
