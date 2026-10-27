export type CameraReason =
  | 'insecure'
  | 'unsupported'
  | 'denied'
  | 'not-found'
  | 'busy'
  | 'unavailable'
  | 'ended'
  | 'playback';
export interface CameraSnapshot {
  readonly status: 'idle' | 'requesting' | 'active' | 'fallback';
  readonly stream: MediaStream | null;
  readonly reason: CameraReason | null;
}
export type CameraVideoElement = Pick<HTMLVideoElement, 'srcObject' | 'play' | 'pause'>;
export interface CameraPageTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
export interface CameraVisibilityTarget extends CameraPageTarget {
  readonly visibilityState: string;
}
export interface CameraDependencies {
  isSecureContext?: () => boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

function reasonFor(error: unknown): CameraReason {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'not-found';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'busy';
  return 'unavailable';
}

function stopTracks(stream: MediaStream): void {
  let tracks: MediaStreamTrack[] = [];
  try {
    tracks = stream.getTracks();
  } catch {
    /* Best-effort cleanup of platform resources. */
  }
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      /* Continue stopping every remaining track. */
    }
  }
}

function clearVideo(video: CameraVideoElement | null, expected?: MediaStream): void {
  if (!video) return;
  try {
    // An older play promise must not interrupt a newer camera session on the same element.
    if (expected && video.srcObject !== null && video.srcObject !== expected) return;
  } catch {
    /* Still attempt cleanup if a platform getter fails. */
  }
  try {
    video.pause();
  } catch {
    /* Clearing the source remains necessary. */
  }
  try {
    video.srcObject = null;
  } catch {
    /* Tracks are stopped independently. */
  }
}

/** Explicit camera preview only. No permission request occurs before start(). */
export class CameraController {
  private snapshot: CameraSnapshot = Object.freeze({ status: 'idle', stream: null, reason: null });
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private pending: Promise<void> | null = null;
  private video: CameraVideoElement | null = null;
  private stream: MediaStream | null = null;
  private trackListeners: { track: MediaStreamTrack; listener: EventListener }[] = [];

  constructor(private readonly dependencies: CameraDependencies = {}) {}

  getSnapshot = (): CameraSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setVideoElement = (video: CameraVideoElement | null): void => {
    if (video === this.video) return;
    this.close();
    this.video = video;
  };

  start = (): Promise<void> => {
    if (this.snapshot.status === 'active' || this.snapshot.status === 'requesting')
      return this.pending ?? Promise.resolve();
    try {
      if (!(this.dependencies.isSecureContext?.() ?? globalThis.isSecureContext === true)) {
        this.fail('insecure');
        return Promise.resolve();
      }
    } catch {
      this.fail('unavailable');
      return Promise.resolve();
    }
    let request = this.dependencies.getUserMedia;
    if (!request) {
      try {
        const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
        if (typeof devices?.getUserMedia === 'function')
          request = devices.getUserMedia.bind(devices);
      } catch {
        /* Missing/denied browser capability uses the same fallback. */
      }
    }
    if (!request) {
      this.fail('unsupported');
      return Promise.resolve();
    }
    if (!this.video) {
      this.fail('playback');
      return Promise.resolve();
    }
    const generation = ++this.generation;
    this.publish('requesting', null, null);
    const pending = this.requestAndPlay(request, generation);
    this.pending = pending;
    const settled = () => {
      if (this.pending === pending) this.pending = null;
    };
    void pending.then(settled, settled);
    return pending;
  };

  close = (): void => {
    this.generation++;
    this.pending = null;
    this.release();
    this.publish('idle', null, null);
  };

  bindLifecycle = (
    documentTarget: CameraVisibilityTarget,
    windowTarget: CameraPageTarget,
  ): (() => void) => {
    const hidden = () => {
      if (documentTarget.visibilityState === 'hidden') this.close();
    };
    const pagehide = () => {
      this.close();
    };
    documentTarget.addEventListener('visibilitychange', hidden);
    windowTarget.addEventListener('pagehide', pagehide);
    hidden();
    return () => {
      documentTarget.removeEventListener('visibilitychange', hidden);
      windowTarget.removeEventListener('pagehide', pagehide);
      this.close();
    };
  };

  private async requestAndPlay(
    request: NonNullable<CameraDependencies['getUserMedia']>,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    let stream: MediaStream | null = null;
    let video: CameraVideoElement | null = null;
    let playback = false;
    try {
      stream = await request({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (generation !== this.generation) {
        stopTracks(stream);
        return;
      }
      this.stream = stream;
      const tracks = stream.getTracks();
      if (!tracks.length) {
        this.fail('not-found');
        return;
      }
      const ended = () => {
        if (generation === this.generation) this.fail('ended');
      };
      for (const track of tracks) {
        track.addEventListener('ended', ended);
        this.trackListeners.push({ track, listener: ended });
      }
      if (tracks.some((track) => track.readyState === 'ended')) {
        this.fail('ended');
        return;
      }
      video = this.video;
      if (!video) {
        this.fail('playback');
        return;
      }
      playback = true;
      video.srcObject = stream;
      await video.play();
      if (generation !== this.generation) {
        clearVideo(video, stream);
        return;
      }
      this.publish('active', stream, null);
    } catch (error) {
      if (generation !== this.generation) {
        if (video && stream) clearVideo(video, stream);
        return;
      }
      this.fail(playback ? 'playback' : reasonFor(error));
    }
  }

  private fail(reason: CameraReason): void {
    this.generation++;
    this.pending = null;
    this.release();
    this.publish('fallback', null, reason);
  }

  private release(): void {
    for (const { track, listener } of this.trackListeners) {
      try {
        track.removeEventListener('ended', listener);
      } catch {
        /* Continue cleanup. */
      }
    }
    this.trackListeners = [];
    const stream = this.stream;
    this.stream = null;
    clearVideo(this.video);
    if (stream) stopTracks(stream);
  }

  private publish(
    status: CameraSnapshot['status'],
    stream: MediaStream | null,
    reason: CameraReason | null,
  ): void {
    if (
      this.snapshot.status === status &&
      this.snapshot.stream === stream &&
      this.snapshot.reason === reason
    )
      return;
    this.snapshot = Object.freeze({ status, stream, reason });
    for (const listener of [...this.listeners]) listener();
  }
}
