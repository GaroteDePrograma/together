import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState, SessionTrack } from "./protocol";
import { TogetherPlayerBridge } from "./player";
import { createAppStore, createInitialAppState } from "./state";

type MockPlayerState = {
  currentUri: string | null;
  progress: number;
  isPlaying: boolean;
  nextTracks: Array<{ uri?: string | null }>;
};

const buildTrack = (trackUri: string, durationMs: number = 180000): SessionTrack => ({
  trackUri,
  artistUri: null,
  title: trackUri,
  artist: "Artist",
  album: "Album",
  imageUrl: null,
  durationMs
});

const buildPlaybackState = (track: SessionTrack, positionMs: number, version: number = 1): PlaybackState => ({
  currentTrack: track,
  positionMs,
  isPlaying: true,
  lastActorId: "member_host",
  lastCommandId: "command_1",
  version,
  updatedAt: "2026-04-02T20:00:00.000Z"
});

const installSpicetifyMock = (playerState: MockPlayerState, options?: { delayedSeek?: boolean }) => {
  let seekAttempts = 0;

  const player = {
    data: {}
  } as Record<string, unknown>;

  Object.defineProperty(player, "item", {
    get: () => (playerState.currentUri ? { uri: playerState.currentUri } : null)
  });

  const playerApi = {
    addEventListener: vi.fn(),
    getProgress: vi.fn(() => playerState.progress),
    isPlaying: vi.fn(() => playerState.isPlaying),
    skipToNext: vi.fn(async () => {
      const nextTrack = playerState.nextTracks.shift();
      playerState.currentUri = nextTrack?.uri ?? null;
      playerState.progress = 0;
      playerState.isPlaying = true;
    }),
    playUri: vi.fn(async (trackUri: string) => {
      playerState.currentUri = trackUri;
      playerState.progress = 0;
      playerState.isPlaying = true;
    }),
    seek: vi.fn((positionMs: number) => {
      seekAttempts += 1;
      if (!options?.delayedSeek || seekAttempts > 1) {
        playerState.progress = positionMs;
      }
    }),
    play: vi.fn(async () => {
      playerState.isPlaying = true;
    }),
    pause: vi.fn(async () => {
      playerState.isPlaying = false;
    })
  };

  const spicetify = {
    addToQueue: vi.fn(async (items: Array<{ uri: string }>) => {
      playerState.nextTracks = items.map((item) => ({ uri: item.uri }));
    }),
    Queue: {
      get nextTracks() {
        return playerState.nextTracks;
      }
    },
    Platform: {
      PlayerAPI: {
        addToQueue: vi.fn(async (items: Array<{ uri: string }>) => {
          playerState.nextTracks = items.map((item) => ({ uri: item.uri }));
        })
      }
    },
    Player: {
      ...playerApi,
      data: player
    }
  };

  (globalThis as any).Spicetify = spicetify;
  return { spicetify, playerApi };
};

describe("TogetherPlayerBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T20:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as any).Spicetify;
  });

  it("switches tracks via the native queue before falling back to playUri", async () => {
    const store = createAppStore(createInitialAppState("http://localhost:3000", "Guest", null));
    const playerState: MockPlayerState = {
      currentUri: "spotify:track:current",
      progress: 42000,
      isPlaying: true,
      nextTracks: []
    };
    const { spicetify, playerApi } = installSpicetifyMock(playerState);
    const bridge = new TogetherPlayerBridge({
      store,
      getActorId: () => "member_guest",
      canPublishEvents: () => true,
      sendPlaybackCommand: vi.fn(),
      requestQueueAdvance: vi.fn()
    });
    const playback = buildPlaybackState(buildTrack("spotify:track:queued"), 65000, 4);

    const syncPromise = bridge.syncPlaybackState(playback);
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(spicetify.addToQueue).toHaveBeenCalledWith([{ uri: "spotify:track:queued" }]);
    expect(playerApi.skipToNext).toHaveBeenCalledTimes(1);
    expect(playerApi.playUri).not.toHaveBeenCalled();
    expect(playerState.currentUri).toBe("spotify:track:queued");
    expect(playerState.progress).toBe(65180);
  });

  it("retries seek alignment when the first seek does not stick", async () => {
    const store = createAppStore(createInitialAppState("http://localhost:3000", "Guest", null));
    const playerState: MockPlayerState = {
      currentUri: "spotify:track:joined",
      progress: 0,
      isPlaying: true,
      nextTracks: []
    };
    const { playerApi } = installSpicetifyMock(playerState, { delayedSeek: true });
    const bridge = new TogetherPlayerBridge({
      store,
      getActorId: () => "member_guest",
      canPublishEvents: () => true,
      sendPlaybackCommand: vi.fn(),
      requestQueueAdvance: vi.fn()
    });
    const playback = buildPlaybackState(buildTrack("spotify:track:joined"), 133000, 7);

    const syncPromise = bridge.syncPlaybackState(playback);
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(playerApi.seek).toHaveBeenCalledTimes(2);
    expect(playerState.progress).toBe(133000);
  });
});
