export const SOCKET_PATH = "/sessions";

export const ClientEvents = {
  roomJoin: "room.join",
  playbackCommand: "playback.command",
  queueAddCurrentTrack: "queue.addCurrentTrack",
  queueRemove: "queue.remove",
  queueSkipNext: "queue.skipNext",
  presenceLeave: "presence.leave"
} as const;

export const ServerEvents = {
  sessionSnapshot: "session.snapshot",
  sessionUpdated: "session.updated",
  presenceUpdated: "presence.updated",
  queueUpdated: "queue.updated",
  playbackApplied: "playback.applied",
  sessionError: "session.error"
} as const;

export type PlaybackCommandType = "SET_TRACK" | "PLAY" | "PAUSE" | "SEEK";
export type NotificationKind = "info" | "success" | "error";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
export type SessionActivityKind =
  | "ROOM"
  | "MEMBER"
  | "PLAYBACK"
  | "QUEUE";

export interface SessionTrack {
  trackUri: string;
  artistUri: string | null;
  title: string;
  artist: string;
  album: string | null;
  imageUrl: string | null;
  durationMs: number;
}

export interface LyricsLine {
  timeMs: number | null;
  text: string;
  translation: string | null;
}

export interface TrackLyricsPayload {
  type: "synced" | "plain" | "not_found" | "instrumental";
  trackName: string;
  artistName: string;
  lines: LyricsLine[];
  plainLyrics: string | null;
}

export interface PlaybackState {
  currentTrack: SessionTrack | null;
  positionMs: number;
  isPlaying: boolean;
  lastActorId: string | null;
  lastCommandId: string | null;
  version: number;
  updatedAt: string;
}

export interface SessionQueueItem extends SessionTrack {
  id: string;
  addedBy: string;
  addedAt: string;
}

export interface ParticipantSummary {
  memberId: string;
  name: string;
  avatarUrl: string | null;
  profileUri: string | null;
  isConnected: boolean;
  joinedAt: string;
}

export interface SessionActivity {
  id: string;
  kind: SessionActivityKind;
  actorId: string | null;
  actorName: string;
  description: string;
  createdAt: string;
}

export interface SessionRoomSnapshot {
  roomCode: string;
  members: ParticipantSummary[];
  playbackState: PlaybackState;
  queue: SessionQueueItem[];
  activityLog: SessionActivity[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotPayload {
  snapshot: SessionRoomSnapshot;
}

export interface SessionErrorPayload {
  message: string;
}

export interface SocketEnvelope<T = unknown> {
  event: string;
  data: T;
}

export interface InitialPlaybackStateInput {
  currentTrack: SessionTrack | null;
  positionMs: number;
  isPlaying: boolean;
}

export interface PlaybackCommand {
  commandId: string;
  actorId: string;
  type: PlaybackCommandType;
  clientObservedAt: string;
  track: SessionTrack | null;
  positionMs: number | null;
  isPlaying: boolean | null;
  observedPreviousTrackUri?: string | null;
}

export interface BootstrapRoomResponse {
  roomCode: string;
  memberId: string;
  snapshot: SessionRoomSnapshot;
  socketPath: string;
}

export interface CreateRoomRequest {
  displayName: string;
  avatarUrl: string | null;
  profileUri?: string | null;
  initialPlayback: InitialPlaybackStateInput | null;
}

export interface JoinRoomRequest {
  displayName: string;
  avatarUrl: string | null;
  profileUri?: string | null;
}

export interface QueueTrackEnvelope {
  roomCode: string;
  memberId: string;
  track: SessionTrack;
}

export interface QueueRemoveEnvelope {
  roomCode: string;
  memberId: string;
  itemId: string;
}

export interface QueueSkipEnvelope {
  roomCode: string;
  memberId: string;
  expectedTrackUri?: string | null;
}

export const normalizeRoomCode = (value: string) => value.trim().toUpperCase();
