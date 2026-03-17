import {
  ClientEvents,
  type BootstrapRoomResponse,
  type CreateRoomRequest,
  type InitialPlaybackStateInput,
  type JoinRoomRequest,
  type PlaybackCommand,
  type PlaybackState,
  type QueueRemoveEnvelope,
  type QueueSkipEnvelope,
  type QueueTrackEnvelope,
  type SessionErrorPayload,
  type SessionRoomSnapshot,
  type SnapshotPayload,
  type SocketEnvelope,
  SOCKET_PATH,
  ServerEvents
} from "./protocol";
import { type AppStore, applySnapshot, resetSessionState, setConnectionState } from "./state";
import { normalizeBaseUrl, showGlobalNotification } from "./utils";

interface SessionClientOptions {
  store: AppStore;
  onPlaybackState: (playback: PlaybackState) => Promise<void> | void;
}

export class TogetherSessionClient {
  private readonly store: AppStore;
  private readonly onPlaybackState: (playback: PlaybackState) => Promise<void> | void;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private activeIdentity: { roomCode: string; memberId: string } | null = null;
  private reconnectAttempt = 0;

  constructor(options: SessionClientOptions) {
    this.store = options.store;
    this.onPlaybackState = options.onPlaybackState;
  }

  private getSessionIdentity() {
    const state = this.store.getState();
    if (!state.roomCode || !state.memberId) {
      return null;
    }

    return {
      roomCode: state.roomCode,
      memberId: state.memberId
    };
  }

  private async requestJson<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
    const baseUrl = normalizeBaseUrl(this.store.getState().backendBaseUrl);
    let response: Response;

    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {})
        }
      });
    } catch {
      throw new Error("Não foi possível conectar ao servidor. Verifique se o backend está online.");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with status ${response.status}`);
    }

    return response.json() as Promise<TResponse>;
  }

  private async handleSnapshot(snapshot: SessionRoomSnapshot) {
    const current = this.store.getState();
    if (snapshot.version < current.snapshotVersion) {
      return;
    }

    this.applyLiveSnapshot(snapshot);
    await this.syncPlaybackState(snapshot.playbackState);
  }

  private toSocketUrl() {
    const baseUrl = new URL(normalizeBaseUrl(this.store.getState().backendBaseUrl));
    baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    baseUrl.pathname = SOCKET_PATH;
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl.toString();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) {
      return;
    }

    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private sendMessage<TPayload>(event: string, data: TPayload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: SocketEnvelope<TPayload> = { event, data };
    this.socket.send(JSON.stringify(message));
  }

  private async handleSocketMessage(raw: string) {
    let envelope: SocketEnvelope<unknown>;

    try {
      envelope = JSON.parse(raw) as SocketEnvelope<unknown>;
    } catch {
      return;
    }

    const snapshotEvents = new Set<string>([
      ServerEvents.sessionSnapshot,
      ServerEvents.sessionUpdated,
      ServerEvents.presenceUpdated,
      ServerEvents.queueUpdated,
      ServerEvents.playbackApplied
    ]);

    if (snapshotEvents.has(envelope.event)) {
      const payload = envelope.data as SnapshotPayload;
      if (payload?.snapshot) {
        await this.handleSnapshot(payload.snapshot);
      }
      return;
    }

    if (envelope.event === ServerEvents.sessionError) {
      const payload = envelope.data as SessionErrorPayload;
      if (payload?.message) {
        showGlobalNotification(payload.message, "error");
      }
    }
  }

  private scheduleReconnect() {
    if (!this.activeIdentity || this.reconnectTimer !== null) {
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(5_000, 500 * this.reconnectAttempt);
    this.store.setState((state) =>
      setConnectionState(state, "connecting", {
        socketConnected: false,
        error: state.connectionError
      })
    );

    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.activeIdentity) {
        return;
      }

      this.connectSocket(this.activeIdentity.roomCode, this.activeIdentity.memberId);
    }, delayMs);
  }

  private connectSocket(roomCode: string, memberId: string) {
    this.activeIdentity = { roomCode, memberId };
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }

    const socket = new WebSocket(this.toSocketUrl());
    this.socket = socket;
    this.store.setState((state) => setConnectionState(state, "connecting", { socketConnected: false, error: null }));

    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }

      this.reconnectAttempt = 0;
      this.store.setState((state) => setConnectionState(state, "connected", { socketConnected: true, error: null }));
      this.sendMessage(ClientEvents.roomJoin, { roomCode, memberId });
    };

    socket.onmessage = async (event) => {
      if (this.socket !== socket || typeof event.data !== "string") {
        return;
      }

      await this.handleSocketMessage(event.data);
    };

    socket.onerror = () => {
      if (this.socket !== socket) {
        return;
      }

      this.store.setState((state) =>
        setConnectionState(state, "error", {
          error: "WebSocket connection failed.",
          socketConnected: false
        })
      );
    };

    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.store.setState((state) =>
        setConnectionState(state, "idle", {
          socketConnected: false,
          error: state.connectionError
        })
      );

      if (this.activeIdentity) {
        this.scheduleReconnect();
      }
    };
  }

  private applyBootstrap(response: BootstrapRoomResponse) {
    this.store.setState((state) => ({
      ...applySnapshot(state, {
        snapshot: response.snapshot,
        roomCode: response.roomCode,
        memberId: response.memberId
      }),
      roomCode: response.roomCode,
      memberId: response.memberId
    }));
  }

  private applyLiveSnapshot(snapshot: SessionRoomSnapshot) {
    this.store.setState((state) =>
      applySnapshot(state, {
        snapshot,
        roomCode: state.roomCode ?? snapshot.roomCode,
        memberId: state.memberId
      })
    );
  }

  private async syncPlaybackState(playback: PlaybackState) {
    await this.onPlaybackState(playback);
  }

  async createRoom(initialPlayback: InitialPlaybackStateInput | null) {
    const payload: CreateRoomRequest = {
      displayName: this.store.getState().displayName,
      avatarUrl: this.store.getState().profileImageUrl,
      initialPlayback
    };

    const response = await this.requestJson<BootstrapRoomResponse>("/rooms", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    this.applyBootstrap(response);
    this.connectSocket(response.roomCode, response.memberId);
  }

  async joinRoom(roomCode: string) {
    const payload: JoinRoomRequest = {
      displayName: this.store.getState().displayName,
      avatarUrl: this.store.getState().profileImageUrl
    };

    const response = await this.requestJson<BootstrapRoomResponse>(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    this.applyBootstrap(response);
    await this.syncPlaybackState(response.snapshot.playbackState);
    this.connectSocket(response.roomCode, response.memberId);
  }

  async reconnectCurrentRoom() {
    const identity = this.getSessionIdentity();
    if (!identity) {
      return;
    }

    const snapshot = await this.requestJson<SessionRoomSnapshot>(`/rooms/${identity.roomCode}`);
    await this.handleSnapshot(snapshot);
    this.connectSocket(identity.roomCode, identity.memberId);
  }

  async leaveRoom() {
    const identity = this.getSessionIdentity();
    if (identity) {
      this.sendMessage(ClientEvents.presenceLeave, identity);
    }

    this.activeIdentity = null;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }

    this.store.setState((state) => resetSessionState(state));
  }

  sendPlaybackCommand(command: PlaybackCommand) {
    const identity = this.getSessionIdentity();
    if (!identity) {
      return;
    }

    this.sendMessage(ClientEvents.playbackCommand, {
      roomCode: identity.roomCode,
      memberId: identity.memberId,
      command
    });
  }

  addTrackToQueue(track: QueueTrackEnvelope["track"]) {
    const identity = this.getSessionIdentity();
    if (!identity) {
      return;
    }

    const payload: QueueTrackEnvelope = {
      roomCode: identity.roomCode,
      memberId: identity.memberId,
      track
    };

    this.sendMessage(ClientEvents.queueAddCurrentTrack, payload);
  }

  removeQueueItem(itemId: string) {
    const identity = this.getSessionIdentity();
    if (!identity) {
      return;
    }

    const payload: QueueRemoveEnvelope = {
      roomCode: identity.roomCode,
      memberId: identity.memberId,
      itemId
    };

    this.sendMessage(ClientEvents.queueRemove, payload);
  }

  skipToNextQueuedTrack(expectedTrackUri?: string | null) {
    const identity = this.getSessionIdentity();
    if (!identity) {
      return;
    }

    const payload: QueueSkipEnvelope = {
      roomCode: identity.roomCode,
      memberId: identity.memberId,
      ...(expectedTrackUri ? { expectedTrackUri } : {})
    };

    this.sendMessage(ClientEvents.queueSkipNext, payload);
  }
}
