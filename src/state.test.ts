import { describe, expect, it } from "vitest";
import type { SessionRoomSnapshot } from "./protocol";
import { applySnapshot, createInitialAppState } from "./state";

const buildSnapshot = (version: number): SessionRoomSnapshot => ({
  roomCode: "ROOM01",
  members: [
    {
      memberId: "member_1",
      name: "Alice",
      avatarUrl: null,
      profileUri: null,
      isConnected: true,
      joinedAt: "2026-03-14T10:00:00.000Z"
    }
  ],
  playbackState: {
    currentTrack: null,
    positionMs: 0,
    isPlaying: false,
    lastActorId: null,
    lastCommandId: null,
    version,
    updatedAt: "2026-03-14T10:00:00.000Z"
  },
  queue: [],
  activityLog: [],
  version,
  createdAt: "2026-03-14T10:00:00.000Z",
  updatedAt: "2026-03-14T10:00:00.000Z"
});

describe("applySnapshot", () => {
  it("accepts newer snapshots", () => {
    const initial = createInitialAppState("http://localhost:3000", "Alice", null);
    const next = applySnapshot(initial, {
      snapshot: buildSnapshot(2),
      roomCode: "ROOM01",
      memberId: "member_1"
    });

    expect(next.snapshotVersion).toBe(2);
    expect(next.roomCode).toBe("ROOM01");
  });

  it("ignores stale snapshots", () => {
    const initial = applySnapshot(createInitialAppState("http://localhost:3000", "Alice", null), {
      snapshot: buildSnapshot(5),
      roomCode: "ROOM01",
      memberId: "member_1"
    });

    const stale = applySnapshot(initial, {
      snapshot: buildSnapshot(3),
      roomCode: "ROOM01",
      memberId: "member_1"
    });

    expect(stale.snapshotVersion).toBe(5);
  });
});
