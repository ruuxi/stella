const SHARED_MIC_STATE_KEY = "__stellaSharedMicrophoneState";
const SHARED_MIC_RELEASE_GRACE_MS = 45_000;

export const SHARED_MIC_CONSTRAINTS: MediaTrackConstraints = {
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

const scheduleRootRelease = (state: SharedMicrophoneState) => {
  clearReleaseTimer(state);
  state.releaseTimer = setTimeout(() => {
    if (state.activeLeaseCount > 0) {
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
  if (state.rootStream) {
    return state.rootStream;
  }

  if (!state.acquirePromise) {
    state.acquirePromise = navigator.mediaDevices
      .getUserMedia({ audio: SHARED_MIC_CONSTRAINTS })
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

export async function acquireSharedMicrophone(): Promise<SharedMicrophoneLease> {
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

export function resetSharedMicrophoneForTests(): void {
  const state = getSharedMicrophoneState();
  clearReleaseTimer(state);
  stopStream(state.rootStream);
  state.rootStream = null;
  state.acquirePromise = null;
  state.activeLeaseCount = 0;
}
