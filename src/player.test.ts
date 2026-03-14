import { describe, expect, it } from "vitest";
import { buildPlaybackCommand, buildTrackSummary, shouldPublishSeek } from "./player";

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
