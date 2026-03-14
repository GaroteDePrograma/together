import type {
  ConnectionStatus,
  NotificationKind,
  ParticipantSummary,
  PlaybackState,
  SessionActivity,
  SessionQueueItem,
  SessionRoomSnapshot
} from "./protocol";
import { createId } from "./utils";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  message: string;
  createdAt: number;
}

export interface AppState {
  backendBaseUrl: string;
  displayName: string;
  profileImageUrl: string | null;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  socketConnected: boolean;
  roomCode: string | null;
  memberId: string | null;
  snapshotVersion: number;
  participants: ParticipantSummary[];
  playback: PlaybackState;
  queue: SessionQueueItem[];
  activityLog: SessionActivity[];
  notifications: AppNotification[];
}

export type StateUpdater = (state: AppState) => AppState;
export type Listener = () => void;

const emptyPlaybackState = (): PlaybackState => ({
  currentTrack: null,
  positionMs: 0,
  isPlaying: false,
  lastActorId: null,
  lastCommandId: null,
  version: 0,
  updatedAt: new Date(0).toISOString()
});

export const createInitialAppState = (
  backendBaseUrl: string,
  displayName: string,
  profileImageUrl: string | null
): AppState => ({
  backendBaseUrl,
  displayName,
  profileImageUrl,
  connectionStatus: "idle",
  connectionError: null,
  socketConnected: false,
  roomCode: null,
  memberId: null,
  snapshotVersion: 0,
  participants: [],
  playback: emptyPlaybackState(),
  queue: [],
  activityLog: [],
  notifications: []
});

export const applySnapshot = (
  state: AppState,
  options: {
    snapshot: SessionRoomSnapshot;
    roomCode: string | null;
    memberId: string | null;
  }
): AppState => {
  const { snapshot, roomCode, memberId } = options;
  if (snapshot.version < state.snapshotVersion) {
    return state;
  }

  return {
    ...state,
    roomCode: roomCode ?? snapshot.roomCode,
    memberId: memberId ?? state.memberId,
    snapshotVersion: snapshot.version,
    participants: snapshot.members,
    playback: snapshot.playbackState,
    queue: snapshot.queue,
    activityLog: snapshot.activityLog
  };
};

export const setConnectionState = (
  state: AppState,
  status: ConnectionStatus,
  details?: { error?: string | null; socketConnected?: boolean }
): AppState => ({
  ...state,
  connectionStatus: status,
  connectionError: details?.error ?? (status === "error" ? state.connectionError : null),
  socketConnected: details?.socketConnected ?? status === "connected"
});

export const pushNotification = (
  state: AppState,
  message: string,
  kind: NotificationKind = "info"
): AppState => ({
  ...state,
  notifications: [{ id: createId("notice"), kind, message, createdAt: Date.now() }, ...state.notifications].slice(0, 5)
});

export const dismissNotification = (state: AppState, id: string): AppState => ({
  ...state,
  notifications: state.notifications.filter((notice) => notice.id !== id)
});

export const resetSessionState = (state: AppState): AppState => ({
  ...state,
  connectionStatus: "idle",
  connectionError: null,
  socketConnected: false,
  roomCode: null,
  memberId: null,
  snapshotVersion: 0,
  participants: [],
  playback: emptyPlaybackState(),
  queue: [],
  activityLog: []
});

export const createAppStore = (initialState: AppState) => {
  let state = initialState;
  const listeners = new Set<Listener>();

  return {
    getState: () => state,
    setState: (updater: StateUpdater) => {
      const nextState = updater(state);
      if (nextState === state) {
        return;
      }

      state = nextState;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
};

export type AppStore = ReturnType<typeof createAppStore>;
