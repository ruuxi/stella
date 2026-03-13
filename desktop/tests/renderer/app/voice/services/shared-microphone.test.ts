import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSharedMicrophone,
  resetSharedMicrophoneForTests,
} from "../../../../../src/features/voice/services/shared-microphone";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class MockMediaStreamTrack {
  stop = vi.fn();
}

class MockMediaStream {
  readonly track: MockMediaStreamTrack;

  constructor() {
    this.track = new MockMediaStreamTrack();
  }

  clone(): MockMediaStream {
    return new MockMediaStream();
  }

  getTracks(): MockMediaStreamTrack[] {
    return [this.track];
  }
}

describe("shared microphone", () => {
  let getUserMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetSharedMicrophoneForTests();
    getUserMediaMock = vi.fn();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: getUserMediaMock,
      },
    });
  });

  afterEach(() => {
    resetSharedMicrophoneForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses one root microphone stream across concurrent leases", async () => {
    const rootStream = new MockMediaStream();
    getUserMediaMock.mockResolvedValue(rootStream as unknown as MediaStream);

    const leaseA = await acquireSharedMicrophone();
    const leaseB = await acquireSharedMicrophone();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(leaseA.stream).not.toBe(leaseB.stream);

    leaseA.release();
    leaseB.release();

    expect(rootStream.track.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(rootStream.track.stop).toHaveBeenCalledTimes(1);
  });

  it("shares a pending root acquisition across simultaneous leases", async () => {
    const rootStream = new MockMediaStream();
    const deferred = createDeferred<MediaStream>();
    getUserMediaMock.mockReturnValue(deferred.promise);

    const leaseAPromise = acquireSharedMicrophone();
    const leaseBPromise = acquireSharedMicrophone();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    deferred.resolve(rootStream as unknown as MediaStream);

    const [leaseA, leaseB] = await Promise.all([leaseAPromise, leaseBPromise]);

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(leaseA.stream).not.toBe(leaseB.stream);

    leaseA.release();
    leaseB.release();
  });

  it("keeps the warm microphone alive during the release grace window", async () => {
    const rootStream = new MockMediaStream();
    getUserMediaMock.mockResolvedValue(rootStream as unknown as MediaStream);

    const leaseA = await acquireSharedMicrophone();
    leaseA.release();

    await vi.advanceTimersByTimeAsync(30_000);

    const leaseB = await acquireSharedMicrophone();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(rootStream.track.stop).not.toHaveBeenCalled();

    leaseB.release();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(rootStream.track.stop).toHaveBeenCalledTimes(1);
  });
});

