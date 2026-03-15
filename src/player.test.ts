import { describe, expect, it } from "vitest";
import {
  buildPlaybackCommand,
  buildTrackSummary,
  estimatePlaybackPositionMs,
  isImmediateNextTrack,
  shouldRequestQueuedAdvanceFromProgress,
  shouldAutoPullQueuedTrack,
  shouldPublishSeek
} from "./player";

describe("buildTrackSummary", () => {
  it("maps spotify player items to a session track", () => {
    const track = buildTrackSummary({
      uri: "spotify:track:123",
      name: "Track",
      artists: [{ name: "Artist" }],
      album: {
        name: "Album",
        images: [{ url: "https://image.test/cover.jpg" }]
      },
      duration_ms: 123000
    });

    expect(track).toEqual({
      trackUri: "spotify:track:123",
      title: "Track",
      artist: "Artist",
      album: "Album",
      imageUrl: "https://image.test/cover.jpg",
      durationMs: 123000
    });
  });
});

describe("buildPlaybackCommand", () => {
  it("creates commands with actor and playback payload", () => {
    const command = buildPlaybackCommand("PLAY", "member_1", {
      positionMs: 12000,
      isPlaying: true
    });

    expect(command.actorId).toBe("member_1");
    expect(command.type).toBe("PLAY");
    expect(command.positionMs).toBe(12000);
    expect(command.isPlaying).toBe(true);
  });
});

describe("shouldPublishSeek", () => {
  it("detects meaningful progress jumps", () => {
    expect(shouldPublishSeek(1000, 55000, 1000)).toBe(true);
  });

  it("ignores expected playback progression", () => {
    expect(shouldPublishSeek(1000, 2200, 1000)).toBe(false);
  });
});

describe("estimatePlaybackPositionMs", () => {
  it("projects playback using elapsed wall time while the track is playing", () => {
    expect(
      estimatePlaybackPositionMs({
        sampledProgressMs: 175000,
        sampledAtMs: 10_000,
        nowMs: 15_000,
        isPlaying: true,
        durationMs: 180000
      })
    ).toBe(180000);
  });
});

describe("shouldAutoPullQueuedTrack", () => {
  const previousTrack = {
    trackUri: "spotify:track:butterfly",
    title: "Butterfly",
    artist: "Smile.dk",
    album: "Album",
    imageUrl: null,
    durationMs: 180000
  };

  const nextTrack = {
    trackUri: "spotify:track:badboy",
    title: "Bad Boy",
    artist: "Artist",
    album: "Album",
    imageUrl: null,
    durationMs: 175000
  };

  it("detects a natural advance when the together queue has pending tracks", () => {
    expect(
      shouldAutoPullQueuedTrack({
        previousTrack,
        nextTrack,
        queueLength: 2,
        previousProgressMs: 178500,
        nextProgressMs: 400
      })
    ).toBe(true);
  });

  it("ignores manual-like changes when the current track was not ending", () => {
    expect(
      shouldAutoPullQueuedTrack({
        previousTrack,
        nextTrack,
        queueLength: 2,
        previousProgressMs: 90000,
        nextProgressMs: 400
      })
    ).toBe(false);
  });
});

describe("isImmediateNextTrack", () => {
  it("only treats the target as skippable when it is the immediate next spotify track", () => {
    expect(
      isImmediateNextTrack(
        [{ uri: "spotify:track:right-next" }, { uri: "spotify:track:queued-later" }],
        "spotify:track:queued-later"
      )
    ).toBe(false);
    expect(isImmediateNextTrack([{ uri: "spotify:track:right-next" }], "spotify:track:right-next")).toBe(true);
  });
});

describe("shouldRequestQueuedAdvanceFromProgress", () => {
  const currentTrack = {
    trackUri: "spotify:track:queue-b",
    title: "Queue B",
    artist: "Artist",
    album: "Album",
    imageUrl: null,
    durationMs: 120000
  };

  it("requests the next together track near the end even without songchange", () => {
    expect(
      shouldRequestQueuedAdvanceFromProgress({
        currentTrack,
        localTrackUri: "spotify:track:queue-b",
        queueLength: 1,
        currentProgressMs: 119300
      })
    ).toBe(true);
  });

  it("does not request when there is no pending together queue", () => {
    expect(
      shouldRequestQueuedAdvanceFromProgress({
        currentTrack,
        localTrackUri: "spotify:track:queue-b",
        queueLength: 0,
        currentProgressMs: 119300
      })
    ).toBe(false);
  });
});
