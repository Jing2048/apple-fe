import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraController, type CameraReason } from './controller';

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

function media(count = 2) {
  const tracks = Array.from({ length: count }, () => new FakeTrack());
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
}

function video() {
  return {
    srcObject: null as HTMLVideoElement['srcObject'],
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Visibility extends EventTarget {
  visibilityState = 'visible';
  set(value: string) {
    this.visibilityState = value;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('explicit camera preview using fake devices only', () => {
  it('does not request until start, uses video-only environment preference and cleans up all tracks', async () => {
    const captured = media();
    const request = vi.fn(async () => captured.stream);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    const target = video();
    const changed = vi.fn();
    const unbind = camera.subscribe(changed);
    camera.setVideoElement(target);
    const idle = camera.getSnapshot();
    expect(camera.getSnapshot()).toBe(idle);
    expect(request).not.toHaveBeenCalled();
    await camera.start();
    expect(request).toHaveBeenCalledExactlyOnceWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
    expect(camera.getSnapshot()).toEqual({
      status: 'active',
      stream: captured.stream,
      reason: null,
    });
    expect(target.srcObject).toBe(captured.stream);
    expect(target.play).toHaveBeenCalledOnce();
    const active = camera.getSnapshot();
    await camera.start();
    expect(camera.getSnapshot()).toBe(active);
    camera.close();
    expect(camera.getSnapshot()).toEqual({ status: 'idle', stream: null, reason: null });
    expect(target.srcObject).toBeNull();
    expect(target.pause).toHaveBeenCalled();
    for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    const closed = camera.getSnapshot();
    camera.close();
    expect(camera.getSnapshot()).toBe(closed);
    expect(changed).toHaveBeenCalledTimes(3);
    unbind();
  });

  it('deduplicates pending starts and stops a permission grant arriving after close', async () => {
    const permission = deferred<MediaStream>();
    const request = vi.fn(() => permission.promise);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    const target = video();
    camera.setVideoElement(target);
    const first = camera.start();
    expect(camera.start()).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    expect(camera.getSnapshot()).toEqual({ status: 'requesting', stream: null, reason: null });
    camera.close();
    const late = media();
    permission.resolve(late.stream);
    await first;
    expect(camera.getSnapshot().status).toBe('idle');
    expect(target.srcObject).toBeNull();
    expect(target.play).not.toHaveBeenCalled();
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('does not prompt if a synchronous subscriber closes the pending preview', async () => {
    const request = vi.fn(async () => media().stream);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    camera.setVideoElement(video());
    camera.subscribe(() => {
      if (camera.getSnapshot().status === 'requesting') camera.close();
    });
    await camera.start();
    expect(request).not.toHaveBeenCalled();
    expect(camera.getSnapshot().status).toBe('idle');
  });

  it.each(['resolve', 'reject'] as const)(
    'cannot reactivate a closed camera when video.play later %ss',
    async (outcome) => {
      const captured = media();
      const playing = deferred<void>();
      const target = video();
      target.play.mockImplementation(() => playing.promise);
      const camera = new CameraController({
        isSecureContext: () => true,
        getUserMedia: async () => captured.stream,
      });
      camera.setVideoElement(target);
      const started = camera.start();
      await Promise.resolve();
      expect(target.srcObject).toBe(captured.stream);
      expect(camera.getSnapshot().status).toBe('requesting');
      camera.close();
      if (outcome === 'resolve') playing.resolve(undefined);
      else playing.reject(new Error('Late browser play failure'));
      await started;
      expect(camera.getSnapshot()).toEqual({ status: 'idle', stream: null, reason: null });
      expect(target.srcObject).toBeNull();
      expect(target.pause).toHaveBeenCalled();
      for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    },
  );

  it('keeps a newer active session intact when an older permission request finally grants', async () => {
    const old = deferred<MediaStream>();
    const fresh = media();
    const request = vi
      .fn<(_: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(fresh.stream);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    const target = video();
    camera.setVideoElement(target);
    const pending = camera.start();
    camera.close();
    await camera.start();
    const stale = media();
    old.resolve(stale.stream);
    await pending;
    expect(camera.getSnapshot().stream).toBe(fresh.stream);
    expect(target.srcObject).toBe(fresh.stream);
    for (const track of fresh.tracks) expect(track.stop).not.toHaveBeenCalled();
    for (const track of stale.tracks) expect(track.stop).toHaveBeenCalledOnce();
    camera.close();
  });

  it('keeps a newer active session intact when an older play promise settles', async () => {
    const old = media();
    const fresh = media();
    const play = deferred<void>();
    const target = video();
    target.play.mockImplementationOnce(() => play.promise);
    const request = vi
      .fn<(_: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockResolvedValueOnce(old.stream)
      .mockResolvedValueOnce(fresh.stream);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    camera.setVideoElement(target);
    const pending = camera.start();
    await Promise.resolve();
    camera.close();
    await camera.start();
    const pauses = target.pause.mock.calls.length;
    play.resolve(undefined);
    await pending;
    expect(camera.getSnapshot().stream).toBe(fresh.stream);
    expect(target.srcObject).toBe(fresh.stream);
    expect(target.pause).toHaveBeenCalledTimes(pauses);
    camera.close();
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'unavailable'],
  ] as const)(
    'maps %s to a safe %s fallback without exposing device messages',
    async (name, reason) => {
      const target = video();
      const camera = new CameraController({
        isSecureContext: () => true,
        getUserMedia: async () => {
          throw { name, message: 'Private device details' };
        },
      });
      camera.setVideoElement(target);
      await camera.start();
      expect(camera.getSnapshot()).toEqual({ status: 'fallback', stream: null, reason });
      expect(JSON.stringify(camera.getSnapshot())).not.toContain('Private device details');
      expect(target.srcObject).toBeNull();
    },
  );

  it('does not prompt on an insecure context or unsupported browser', async () => {
    const request = vi.fn(async () => media().stream);
    const insecure = new CameraController({ isSecureContext: () => false, getUserMedia: request });
    insecure.setVideoElement(video());
    await insecure.start();
    expect(insecure.getSnapshot().reason).toBe('insecure');
    expect(request).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', {});
    const unsupported = new CameraController({ isSecureContext: () => true });
    unsupported.setVideoElement(video());
    await unsupported.start();
    expect(unsupported.getSnapshot().reason).toBe('unsupported');
  });

  it('uses secure-context capability rather than blocking a file protocol string', async () => {
    const captured = media();
    const request = vi.fn(async () => captured.stream);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: request } });
    vi.stubGlobal('location', { protocol: 'file:' });
    const camera = new CameraController();
    camera.setVideoElement(video());
    await camera.start();
    expect(request).toHaveBeenCalledOnce();
    expect(camera.getSnapshot().status).toBe('active');
    camera.close();
  });

  it('stops every track on ended and requires an explicit new start', async () => {
    const captured = media();
    const fresh = media();
    const request = vi
      .fn<(_: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockResolvedValueOnce(captured.stream)
      .mockResolvedValueOnce(fresh.stream);
    const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
    const target = video();
    camera.setVideoElement(target);
    await camera.start();
    captured.tracks[0]!.end();
    expect(camera.getSnapshot()).toEqual({ status: 'fallback', stream: null, reason: 'ended' });
    expect(target.srcObject).toBeNull();
    for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    await camera.start();
    captured.tracks[0]!.end();
    expect(camera.getSnapshot().stream).toBe(fresh.stream);
    camera.close();
  });

  it.each(['hidden', 'pagehide', 'unmount'] as const)(
    'releases all capture on %s and supports StrictMode lifecycle rebinding',
    async (action) => {
      const captured = media();
      const fresh = media();
      const request = vi
        .fn<(_: MediaStreamConstraints) => Promise<MediaStream>>()
        .mockResolvedValueOnce(captured.stream)
        .mockResolvedValueOnce(fresh.stream);
      const camera = new CameraController({ isSecureContext: () => true, getUserMedia: request });
      const target = video();
      const document = new Visibility();
      const window = new EventTarget();
      camera.setVideoElement(target);
      const cleanup = camera.bindLifecycle(document, window);
      await camera.start();
      if (action === 'hidden') document.set('hidden');
      else if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      else cleanup();
      expect(camera.getSnapshot().status).toBe('idle');
      expect(target.srcObject).toBeNull();
      for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
      document.set('visible');
      expect(request).toHaveBeenCalledOnce();
      cleanup();
      const cleanupAgain = camera.bindLifecycle(document, window);
      await camera.start();
      expect(camera.getSnapshot().stream).toBe(fresh.stream);
      cleanupAgain();
      for (const track of fresh.tracks) expect(track.stop).toHaveBeenCalledOnce();
    },
  );

  it('releases capture when the video ref switches or unmounts', async () => {
    const captured = media();
    const camera = new CameraController({
      isSecureContext: () => true,
      getUserMedia: async () => captured.stream,
    });
    const original = video();
    const replacement = video();
    camera.setVideoElement(original);
    await camera.start();
    camera.setVideoElement(replacement);
    expect(original.srcObject).toBeNull();
    expect(replacement.srcObject).toBeNull();
    expect(camera.getSnapshot().status).toBe('idle');
    for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    camera.setVideoElement(null);
    expect(replacement.pause).toHaveBeenCalled();
  });

  it.each(['resolve-reject', 'sync-throw'] as const)(
    'falls back and stops every track on %s video playback failure',
    async (mode) => {
      const captured = media();
      const target = video();
      target.play.mockImplementation(() => {
        if (mode === 'sync-throw') throw new Error('Playback failure');
        return Promise.reject(new Error('Playback failure'));
      });
      const camera = new CameraController({
        isSecureContext: () => true,
        getUserMedia: async () => captured.stream,
      });
      camera.setVideoElement(target);
      await camera.start();
      expect(camera.getSnapshot()).toEqual({
        status: 'fallback',
        stream: null,
        reason: 'playback' satisfies CameraReason,
      });
      expect(target.srcObject).toBeNull();
      for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    },
  );
});
