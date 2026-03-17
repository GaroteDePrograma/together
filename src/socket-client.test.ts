import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapRoomResponse, InitialPlaybackStateInput, PlaybackState, SessionTrack } from "./protocol";
import { TogetherSessionClient } from "./socket-client";
import { createAppStore, createInitialAppState } from "./state";

type MockSocketInstance = {
  url: string;
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const track: SessionTrack = {
  trackUri: "spotify:track:joined-track",
  title: "Joined Track",
  artist: "Artist",
  album: "Album",
  imageUrl: null,
  durationMs: 180000
};

const buildPlaybackState = (version: number): PlaybackState => ({
  currentTrack: track,
  positionMs: 42000,
  isPlaying: true,
  lastActorId: "member_host",
  lastCommandId: "command_1",
  version,
  updatedAt: "2026-03-17T10:00:00.000Z"
});

const buildBootstrapResponse = (options?: {
  roomCode?: string;
  memberId?: string;
  playbackState?: PlaybackState;
}): BootstrapRoomResponse => ({
  roomCode: options?.roomCode ?? "ROOM01",
  memberId: options?.memberId ?? "member_guest",
  socketPath: "/sessions",
  snapshot: {
    roomCode: options?.roomCode ?? "ROOM01",
    members: [
      {
        memberId: "member_host",
        name: "Host",
        avatarUrl: null,
        isConnected: true,
        joinedAt: "2026-03-17T09:59:00.000Z"
      },
      {
        memberId: options?.memberId ?? "member_guest",
        name: "Guest",
        avatarUrl: null,
        isConnected: false,
        joinedAt: "2026-03-17T10:00:00.000Z"
      }
    ],
    playbackState: options?.playbackState ?? buildPlaybackState(3),
    queue: [],
    activityLog: [],
    version: 3,
    createdAt: "2026-03-17T09:59:00.000Z",
    updatedAt: "2026-03-17T10:00:00.000Z"
  }
});

const waitForAssertion = async (assertion: () => void, attempts: number = 10) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
    }
  }

  throw lastError;
};

describe("TogetherSessionClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let socketInstances: MockSocketInstance[];

  beforeEach(() => {
    fetchMock = vi.fn();
    socketInstances = [];

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "WebSocket",
      class MockWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readonly url: string;
        readyState = MockWebSocket.CONNECTING;
        onopen: ((event?: unknown) => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: ((event?: unknown) => void) | null = null;
        onclose: ((event?: unknown) => void) | null = null;
        send = vi.fn();
        close = vi.fn(() => {
          this.readyState = MockWebSocket.CLOSED;
        });

        constructor(url: string) {
          this.url = url;
          socketInstances.push(this);
        }
      } as unknown as typeof WebSocket
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("synchronizes playback immediately during join before opening the socket", async () => {
    const store = createAppStore(createInitialAppState("http://localhost:3000", "Guest", null));
    const response = buildBootstrapResponse();
    let resolvePlaybackSync: (() => void) | null = null;
    const onPlaybackState = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePlaybackSync = resolve;
        })
    );

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => response
    });

    const client = new TogetherSessionClient({
      store,
      onPlaybackState
    });

    const joinPromise = client.joinRoom("ROOM01");
    await waitForAssertion(() => expect(onPlaybackState).toHaveBeenCalledTimes(1));

    expect(store.getState().roomCode).toBe("ROOM01");
    expect(store.getState().memberId).toBe("member_guest");
    expect(store.getState().playback).toEqual(response.snapshot.playbackState);
    expect(onPlaybackState).toHaveBeenCalledWith(response.snapshot.playbackState);
    expect(socketInstances).toHaveLength(0);

    resolvePlaybackSync?.();
    await joinPromise;

    expect(socketInstances).toHaveLength(1);
    expect(socketInstances[0]?.url).toBe("ws://localhost:3000/sessions");
  });

  it("does not synchronize playback immediately when creating a room", async () => {
    const store = createAppStore(createInitialAppState("http://localhost:3000", "Host", null));
    const response = buildBootstrapResponse({
      memberId: "member_host"
    });
    const onPlaybackState = vi.fn();
    const initialPlayback: InitialPlaybackStateInput = {
      currentTrack: track,
      positionMs: 1000,
      isPlaying: true
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => response
    });

    const client = new TogetherSessionClient({
      store,
      onPlaybackState
    });

    await client.createRoom(initialPlayback);

    expect(onPlaybackState).not.toHaveBeenCalled();
    expect(socketInstances).toHaveLength(1);
  });
});
