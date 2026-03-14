"use strict";
var TogetherBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    render: () => render
  });

  // src/utils.ts
  var DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";
  var SEEK_SYNC_THRESHOLD_MS = 1500;
  var SEEK_DETECTION_TOLERANCE_MS = 1800;
  var LOCAL_STORAGE_KEYS = {
    backendBaseUrl: "together_backend_base_url",
    displayName: "together_display_name",
    profileImageUrl: "together_profile_image_url"
  };
  var createId = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${random}`;
  };
  var normalizeBaseUrl = (value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return DEFAULT_BACKEND_BASE_URL;
    }
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  };
  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var formatDuration = (ms) => {
    const safe = Math.max(0, Math.floor(ms / 1e3));
    const minutes = Math.floor(safe / 60);
    const seconds = safe % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };
  var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  var readSpicetifyStorage = (key) => {
    const storage = Spicetify?.LocalStorage;
    if (!storage) {
      return localStorage.getItem(key);
    }
    return storage.get(key);
  };
  var writeSpicetifyStorage = (key, value) => {
    const storage = Spicetify?.LocalStorage;
    if (!storage) {
      localStorage.setItem(key, value);
      return;
    }
    storage.set(key, value);
  };
  var showGlobalNotification = (message, kind = "info") => {
    const prefix = kind === "error" ? "Together error" : "Together";
    if (Spicetify?.showNotification) {
      Spicetify.showNotification(`${prefix}: ${message}`);
    }
  };

  // src/player.ts
  var safePlayerProgress = () => Spicetify?.Player?.getProgress?.() ?? 0;
  var safePlayerIsPlaying = () => Boolean(Spicetify?.Player?.isPlaying?.());
  var buildTrackSummary = (playerItem) => {
    if (!playerItem?.uri) {
      return null;
    }
    const firstArtist = Array.isArray(playerItem.artists) ? playerItem.artists[0] : playerItem.artists;
    const images = playerItem.album?.images ?? playerItem.images ?? [];
    return {
      trackUri: playerItem.uri,
      title: playerItem.name ?? "Faixa desconhecida",
      artist: firstArtist?.name ?? playerItem.artist?.name ?? "Artista desconhecido",
      album: playerItem.album?.name ?? null,
      imageUrl: images[0]?.url ?? null,
      durationMs: Number(playerItem.duration?.milliseconds ?? playerItem.duration_ms ?? playerItem.duration ?? 0)
    };
  };
  var readInitialPlayback = () => {
    const currentTrack = buildTrackSummary(Spicetify?.Player?.data?.item);
    if (!currentTrack) {
      return null;
    }
    return {
      currentTrack,
      positionMs: safePlayerProgress(),
      isPlaying: safePlayerIsPlaying()
    };
  };
  var buildPlaybackCommand = (type, actorId, options = {}) => ({
    commandId: createId("command"),
    actorId,
    type,
    clientObservedAt: (/* @__PURE__ */ new Date()).toISOString(),
    track: options.track ?? null,
    positionMs: options.positionMs ?? null,
    isPlaying: options.isPlaying ?? null
  });
  var shouldPublishSeek = (previousPositionMs, nextPositionMs, elapsedMs, toleranceMs = SEEK_DETECTION_TOLERANCE_MS) => {
    const observedDelta = Math.abs(nextPositionMs - previousPositionMs - elapsedMs);
    return observedDelta > toleranceMs;
  };
  var TogetherPlayerBridge = class {
    store;
    getActorId;
    canPublishEvents;
    sendPlaybackCommand;
    started = false;
    lastProgressSampleMs = 0;
    lastProgressSampleAt = Date.now();
    lastAppliedPlaybackVersion = 0;
    suppressedUntil = {
      songchange: 0,
      playpause: 0,
      progress: 0
    };
    constructor(options) {
      this.store = options.store;
      this.getActorId = options.getActorId;
      this.canPublishEvents = options.canPublishEvents;
      this.sendPlaybackCommand = options.sendPlaybackCommand;
    }
    start() {
      if (this.started) {
        return;
      }
      this.started = true;
      this.lastProgressSampleMs = safePlayerProgress();
      this.lastProgressSampleAt = Date.now();
      Spicetify.Player.addEventListener("songchange", this.handleSongChange);
      Spicetify.Player.addEventListener("onplaypause", this.handlePlayPause);
      Spicetify.Player.addEventListener("onprogress", this.handleProgress);
    }
    isSuppressed(kind) {
      return Date.now() < this.suppressedUntil[kind];
    }
    suppress(kind, durationMs) {
      this.suppressedUntil[kind] = Math.max(this.suppressedUntil[kind], Date.now() + durationMs);
    }
    suppressAll(durationMs) {
      this.suppress("songchange", durationMs);
      this.suppress("playpause", durationMs);
      this.suppress("progress", durationMs);
    }
    emitCommand(type, options = {}) {
      if (!this.started || !this.canPublishEvents()) {
        return;
      }
      const actorId = this.getActorId();
      if (!actorId) {
        return;
      }
      this.sendPlaybackCommand(buildPlaybackCommand(type, actorId, options));
    }
    handleSongChange = () => {
      this.lastProgressSampleMs = safePlayerProgress();
      this.lastProgressSampleAt = Date.now();
      if (this.isSuppressed("songchange")) {
        return;
      }
      const track = buildTrackSummary(Spicetify?.Player?.data?.item);
      if (!track) {
        return;
      }
      this.emitCommand("SET_TRACK", {
        track,
        positionMs: safePlayerProgress(),
        isPlaying: safePlayerIsPlaying()
      });
    };
    handlePlayPause = () => {
      if (this.isSuppressed("playpause")) {
        return;
      }
      this.emitCommand(safePlayerIsPlaying() ? "PLAY" : "PAUSE", {
        positionMs: safePlayerProgress(),
        isPlaying: safePlayerIsPlaying()
      });
    };
    handleProgress = () => {
      const currentProgress = safePlayerProgress();
      const now = Date.now();
      if (!this.isSuppressed("progress")) {
        if (shouldPublishSeek(this.lastProgressSampleMs, currentProgress, now - this.lastProgressSampleAt)) {
          this.emitCommand("SEEK", {
            positionMs: currentProgress
          });
        }
      }
      this.lastProgressSampleMs = currentProgress;
      this.lastProgressSampleAt = now;
    };
    async syncPlaybackState(playback) {
      if (playback.version <= this.lastAppliedPlaybackVersion) {
        return;
      }
      this.lastAppliedPlaybackVersion = playback.version;
      this.suppressAll(2e3);
      const targetTrack = playback.currentTrack;
      const currentTrackUri = Spicetify?.Player?.data?.item?.uri ?? null;
      if (targetTrack?.trackUri && currentTrackUri !== targetTrack.trackUri) {
        await Spicetify.Player.playUri(targetTrack.trackUri);
        await wait(180);
      }
      const currentProgress = safePlayerProgress();
      if (Math.abs(currentProgress - playback.positionMs) > SEEK_SYNC_THRESHOLD_MS) {
        Spicetify.Player.seek(playback.positionMs);
      }
      const isPlaying = safePlayerIsPlaying();
      if (playback.isPlaying !== isPlaying) {
        if (playback.isPlaying) {
          await Spicetify.Player.play();
        } else {
          await Spicetify.Player.pause();
        }
      }
      this.lastProgressSampleMs = safePlayerProgress();
      this.lastProgressSampleAt = Date.now();
    }
  };

  // src/protocol.ts
  var SOCKET_PATH = "/sessions";
  var ClientEvents = {
    roomJoin: "room.join",
    playbackCommand: "playback.command",
    queueAddCurrentTrack: "queue.addCurrentTrack",
    queueRemove: "queue.remove",
    queueSkipNext: "queue.skipNext",
    presenceLeave: "presence.leave"
  };
  var ServerEvents = {
    sessionSnapshot: "session.snapshot",
    sessionUpdated: "session.updated",
    presenceUpdated: "presence.updated",
    queueUpdated: "queue.updated",
    playbackApplied: "playback.applied",
    sessionError: "session.error"
  };
  var normalizeRoomCode = (value) => value.trim().toUpperCase();

  // src/state.ts
  var emptyPlaybackState = () => ({
    currentTrack: null,
    positionMs: 0,
    isPlaying: false,
    lastActorId: null,
    lastCommandId: null,
    version: 0,
    updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  });
  var createInitialAppState = (backendBaseUrl, displayName, profileImageUrl) => ({
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
  var applySnapshot = (state, options) => {
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
  var setConnectionState = (state, status, details) => ({
    ...state,
    connectionStatus: status,
    connectionError: details?.error ?? (status === "error" ? state.connectionError : null),
    socketConnected: details?.socketConnected ?? status === "connected"
  });
  var resetSessionState = (state) => ({
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
  var createAppStore = (initialState) => {
    let state = initialState;
    const listeners = /* @__PURE__ */ new Set();
    return {
      getState: () => state,
      setState: (updater) => {
        const nextState = updater(state);
        if (nextState === state) {
          return;
        }
        state = nextState;
        listeners.forEach((listener) => listener());
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  };

  // src/socket-client.ts
  var TogetherSessionClient = class {
    store;
    onPlaybackState;
    socket = null;
    reconnectTimer = null;
    activeIdentity = null;
    reconnectAttempt = 0;
    constructor(options) {
      this.store = options.store;
      this.onPlaybackState = options.onPlaybackState;
    }
    getSessionIdentity() {
      const state = this.store.getState();
      if (!state.roomCode || !state.memberId) {
        return null;
      }
      return {
        roomCode: state.roomCode,
        memberId: state.memberId
      };
    }
    async requestJson(path, init) {
      const baseUrl = normalizeBaseUrl(this.store.getState().backendBaseUrl);
      let response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            "content-type": "application/json",
            ...init?.headers ?? {}
          }
        });
      } catch {
        throw new Error("N\xE3o foi poss\xEDvel conectar ao servidor. Verifique se o backend est\xE1 online.");
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Request failed with status ${response.status}`);
      }
      return response.json();
    }
    async handleSnapshot(snapshot) {
      const current = this.store.getState();
      if (snapshot.version < current.snapshotVersion) {
        return;
      }
      this.store.setState(
        (state) => applySnapshot(state, {
          snapshot,
          roomCode: state.roomCode ?? snapshot.roomCode,
          memberId: state.memberId
        })
      );
      await this.onPlaybackState(snapshot.playbackState);
    }
    toSocketUrl() {
      const baseUrl = new URL(normalizeBaseUrl(this.store.getState().backendBaseUrl));
      baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
      baseUrl.pathname = SOCKET_PATH;
      baseUrl.search = "";
      baseUrl.hash = "";
      return baseUrl.toString();
    }
    clearReconnectTimer() {
      if (this.reconnectTimer === null) {
        return;
      }
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    sendMessage(event, data) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const message = { event, data };
      this.socket.send(JSON.stringify(message));
    }
    async handleSocketMessage(raw) {
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return;
      }
      const snapshotEvents = /* @__PURE__ */ new Set([
        ServerEvents.sessionSnapshot,
        ServerEvents.sessionUpdated,
        ServerEvents.presenceUpdated,
        ServerEvents.queueUpdated,
        ServerEvents.playbackApplied
      ]);
      if (snapshotEvents.has(envelope.event)) {
        const payload = envelope.data;
        if (payload?.snapshot) {
          await this.handleSnapshot(payload.snapshot);
        }
        return;
      }
      if (envelope.event === ServerEvents.sessionError) {
        const payload = envelope.data;
        if (payload?.message) {
          showGlobalNotification(payload.message, "error");
        }
      }
    }
    scheduleReconnect() {
      if (!this.activeIdentity || this.reconnectTimer !== null) {
        return;
      }
      this.reconnectAttempt += 1;
      const delayMs = Math.min(5e3, 500 * this.reconnectAttempt);
      this.store.setState(
        (state) => setConnectionState(state, "connecting", {
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
    connectSocket(roomCode, memberId) {
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
        this.store.setState(
          (state) => setConnectionState(state, "error", {
            error: "WebSocket connection failed.",
            socketConnected: false
          })
        );
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.store.setState(
          (state) => setConnectionState(state, "idle", {
            socketConnected: false,
            error: state.connectionError
          })
        );
        if (this.activeIdentity) {
          this.scheduleReconnect();
        }
      };
    }
    applyBootstrap(response) {
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
    async createRoom(initialPlayback) {
      const payload = {
        displayName: this.store.getState().displayName,
        avatarUrl: this.store.getState().profileImageUrl,
        initialPlayback
      };
      const response = await this.requestJson("/rooms", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      this.applyBootstrap(response);
      this.connectSocket(response.roomCode, response.memberId);
    }
    async joinRoom(roomCode) {
      const payload = {
        displayName: this.store.getState().displayName,
        avatarUrl: this.store.getState().profileImageUrl
      };
      const response = await this.requestJson(`/rooms/${roomCode}/join`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      this.applyBootstrap(response);
      this.connectSocket(response.roomCode, response.memberId);
    }
    async reconnectCurrentRoom() {
      const identity = this.getSessionIdentity();
      if (!identity) {
        return;
      }
      const snapshot = await this.requestJson(`/rooms/${identity.roomCode}`);
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
    sendPlaybackCommand(command) {
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
    addTrackToQueue(track) {
      const identity = this.getSessionIdentity();
      if (!identity) {
        return;
      }
      const payload = {
        roomCode: identity.roomCode,
        memberId: identity.memberId,
        track
      };
      this.sendMessage(ClientEvents.queueAddCurrentTrack, payload);
    }
    removeQueueItem(itemId) {
      const identity = this.getSessionIdentity();
      if (!identity) {
        return;
      }
      const payload = {
        roomCode: identity.roomCode,
        memberId: identity.memberId,
        itemId
      };
      this.sendMessage(ClientEvents.queueRemove, payload);
    }
    skipToNextQueuedTrack() {
      const identity = this.getSessionIdentity();
      if (!identity) {
        return;
      }
      const payload = {
        roomCode: identity.roomCode,
        memberId: identity.memberId
      };
      this.sendMessage(ClientEvents.queueSkipNext, payload);
    }
  };

  // src/index.ts
  var react = Spicetify.React;
  var h = react.createElement;
  var { useEffect, useMemo, useState } = react;
  var loadDisplayName = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.displayName) ?? "Spotify listener";
  var loadProfileImageUrl = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.profileImageUrl);
  var loadBackendBaseUrl = () => normalizeBaseUrl(readSpicetifyStorage(LOCAL_STORAGE_KEYS.backendBaseUrl) ?? DEFAULT_BACKEND_BASE_URL);
  var store = createAppStore(createInitialAppState(loadBackendBaseUrl(), loadDisplayName(), loadProfileImageUrl()));
  var sessionClient = null;
  var playerBridge = null;
  var initialized = false;
  var togetherQueueContextMenuItem = null;
  var TRACK_URI_PREFIX = "spotify:track:";
  var TOGETHER_CONTEXT_MENU_ICON = '<path d="M17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-10 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.485 0-4.5 1.79-4.5 4V20h9v-3c0-.728.173-1.415.48-2.023A5.978 5.978 0 0 0 7 13Zm10 0c-.944 0-1.837.218-2.632.607A5.994 5.994 0 0 1 16.5 17v3h5v-3c0-2.21-2.015-4-4.5-4Z"/>';
  var isSpotifyTrackUri = (uri) => {
    const parsedUri = Spicetify?.URI?.from?.(uri);
    return parsedUri?.type === Spicetify?.URI?.Type?.TRACK || uri.startsWith(TRACK_URI_PREFIX);
  };
  var extractTrackIdFromUri = (uri) => {
    const parsedUri = Spicetify?.URI?.from?.(uri);
    if (parsedUri?.type === Spicetify?.URI?.Type?.TRACK && typeof parsedUri.id === "string") {
      return parsedUri.id;
    }
    const match = /^spotify:track:([A-Za-z0-9]+)(?:[?:].*)?$/i.exec(uri.trim());
    if (!match) {
      return null;
    }
    return match[1] ?? null;
  };
  var ensureControllers = () => {
    ensureQueueContextMenu();
    if (initialized) {
      return;
    }
    playerBridge = new TogetherPlayerBridge({
      store,
      getActorId: () => store.getState().memberId,
      canPublishEvents: () => Boolean(store.getState().roomCode && store.getState().socketConnected),
      sendPlaybackCommand: (command) => sessionClient?.sendPlaybackCommand(command)
    });
    sessionClient = new TogetherSessionClient({
      store,
      onPlaybackState: async (playback) => {
        await playerBridge?.syncPlaybackState(playback);
      }
    });
    playerBridge.start();
    initialized = true;
  };
  var notify = (message, kind = "info") => {
    showGlobalNotification(message, kind);
  };
  var extractSpotifyAvatarUrl = (user) => user?.avatarUrl ?? user?.imageUrl ?? user?.images?.[0]?.url ?? user?.avatar?.url ?? user?.photo_url ?? null;
  var extractSpotifyDisplayName = (user) => user?.displayName ?? user?.display_name ?? user?.name ?? null;
  var readSpotifyProfile = async () => {
    let displayName = null;
    let avatarUrl = null;
    try {
      const user = await Spicetify.Platform.UserAPI.getUser();
      displayName = extractSpotifyDisplayName(user);
      avatarUrl = extractSpotifyAvatarUrl(user);
    } catch {
    }
    if (displayName && avatarUrl) {
      return { displayName, avatarUrl };
    }
    try {
      const me = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me");
      return {
        displayName: displayName ?? me?.display_name ?? null,
        avatarUrl: avatarUrl ?? me?.images?.[0]?.url ?? null
      };
    } catch {
      return { displayName, avatarUrl };
    }
  };
  var syncProfileFromSpotify = async () => {
    try {
      const profile = await readSpotifyProfile();
      if (!profile.displayName && !profile.avatarUrl) {
        return;
      }
      if (profile.displayName) {
        writeSpicetifyStorage(LOCAL_STORAGE_KEYS.displayName, profile.displayName);
      }
      if (profile.avatarUrl) {
        writeSpicetifyStorage(LOCAL_STORAGE_KEYS.profileImageUrl, profile.avatarUrl);
      }
      store.setState((state) => ({
        ...state,
        displayName: profile.displayName ?? state.displayName,
        profileImageUrl: profile.avatarUrl ?? state.profileImageUrl
      }));
    } catch {
    }
  };
  var mapSpotifyTrackToSessionTrack = (track) => {
    const rawUri = typeof track?.uri === "string" ? track.uri : null;
    const trackId = rawUri ? extractTrackIdFromUri(rawUri) : null;
    if (!rawUri || !trackId) {
      return null;
    }
    const artists = Array.isArray(track?.artists) ? track.artists : Array.isArray(track?.artists?.items) ? track.artists.items : [];
    const album = track?.album ?? track?.albumOfTrack ?? null;
    const images = Array.isArray(album?.images) ? album.images : Array.isArray(track?.images) ? track.images : Array.isArray(track?.coverArt?.sources) ? track.coverArt.sources : [];
    return {
      trackUri: rawUri,
      title: track?.name ?? track?.title ?? "Faixa desconhecida",
      artist: artists[0]?.name ?? artists[0]?.profile?.name ?? track?.artist?.name ?? "Artista desconhecido",
      album: album?.name ?? album?.title ?? null,
      imageUrl: images[0]?.url ?? images[0]?.source ?? null,
      durationMs: Number(
        track?.duration_ms ?? track?.duration?.totalMilliseconds ?? track?.duration?.milliseconds ?? track?.duration ?? 0
      )
    };
  };
  var fetchTrackSummaryByUri = async (uri) => {
    const trackId = extractTrackIdFromUri(uri);
    if (!trackId) {
      return null;
    }
    try {
      const track = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`);
      return buildTrackSummary(track) ?? mapSpotifyTrackToSessionTrack(track);
    } catch {
      return null;
    }
  };
  var fetchTrackSummariesByUris = async (uris) => {
    const tracks = await Promise.all(uris.map((uri) => fetchTrackSummaryByUri(uri)));
    return tracks.filter((track) => Boolean(track));
  };
  var addSelectedTracksToTogetherQueue = async (uris) => {
    ensureControllers();
    const state = store.getState();
    if (!state.roomCode || !state.memberId || !state.socketConnected) {
      notify("Entre em uma sala do Together antes de adicionar faixas.", "info");
      return;
    }
    const trackUris = uris.filter(isSpotifyTrackUri);
    if (!trackUris.length) {
      notify("Selecione pelo menos uma faixa do Spotify.", "info");
      return;
    }
    try {
      const tracks = await fetchTrackSummariesByUris(trackUris);
      if (!tracks.length) {
        notify("N\xE3o foi poss\xEDvel ler as faixas selecionadas.", "error");
        return;
      }
      tracks.forEach((track) => sessionClient?.addTrackToQueue(track));
      notify(
        tracks.length === 1 ? `${tracks[0].title} adicionada \xE0 fila do Together.` : `${tracks.length} faixas adicionadas \xE0 fila do Together.`,
        "success"
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "N\xE3o foi poss\xEDvel adicionar \xE0 fila do Together.", "error");
    }
  };
  var ensureQueueContextMenu = () => {
    if (togetherQueueContextMenuItem || !Spicetify?.ContextMenu?.Item) {
      return;
    }
    togetherQueueContextMenuItem = new Spicetify.ContextMenu.Item(
      "Adicionar \xE0 fila do Together",
      (uris) => {
        void addSelectedTracksToTogetherQueue(uris);
      },
      (uris) => {
        const state = store.getState();
        return Boolean(
          state.roomCode && state.memberId && state.socketConnected && Array.isArray(uris) && uris.length && uris.every((uri) => isSpotifyTrackUri(uri))
        );
      },
      TOGETHER_CONTEXT_MENU_ICON
    );
    togetherQueueContextMenuItem.register();
  };
  var useAppState = () => {
    const [state, setState] = useState(store.getState());
    useEffect(() => store.subscribe(() => setState(store.getState())), []);
    return state;
  };
  var updateBackendBaseUrl = (value) => {
    const normalized = normalizeBaseUrl(value);
    writeSpicetifyStorage(LOCAL_STORAGE_KEYS.backendBaseUrl, normalized);
    store.setState((state) => ({
      ...state,
      backendBaseUrl: normalized
    }));
  };
  var createRoom = async () => {
    ensureControllers();
    await syncProfileFromSpotify();
    try {
      await sessionClient?.createRoom(readInitialPlayback() ?? null);
      notify("Sala criada e conectada.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "N\xE3o foi poss\xEDvel criar a sala.", "error");
    }
  };
  var joinRoom = async (roomCode) => {
    ensureControllers();
    await syncProfileFromSpotify();
    try {
      await sessionClient?.joinRoom(normalizeRoomCode(roomCode));
      notify("Entrou na sess\xE3o.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "N\xE3o foi poss\xEDvel entrar na sala.", "error");
    }
  };
  var reconnectRoom = async () => {
    try {
      await sessionClient?.reconnectCurrentRoom();
      notify("Reconectado ao servidor.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Reconex\xE3o falhou.", "error");
    }
  };
  var leaveRoom = async () => {
    await sessionClient?.leaveRoom();
    notify("Sess\xE3o encerrada neste cliente.", "info");
  };
  var addCurrentTrackToQueue = () => {
    const track = buildTrackSummary(Spicetify?.Player?.data?.item);
    if (!track) {
      notify("Nenhuma faixa ativa para adicionar.", "error");
      return;
    }
    sessionClient?.addTrackToQueue(track);
  };
  var removeQueueItem = (itemId) => {
    sessionClient?.removeQueueItem(itemId);
  };
  var skipNextQueuedTrack = () => {
    sessionClient?.skipToNextQueuedTrack();
  };
  var formatRelativeTime = (isoDate) => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1e3));
    if (elapsedSeconds < 10) {
      return "agora";
    }
    if (elapsedSeconds < 60) {
      return `${elapsedSeconds}s`;
    }
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
      return `${elapsedHours}h`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    return `${elapsedDays}d`;
  };
  var getInitials = (value) => value.trim().split(/\s+/).slice(0, 2).map((segment) => segment[0]?.toUpperCase() ?? "").join("") || "SP";
  var resolveParticipantPresence = (participant, options) => {
    if (participant.isConnected || options.isSelf && options.socketConnected) {
      return "online";
    }
    if (options.isSelf && options.connectionStatus === "connecting") {
      return "connecting";
    }
    return "offline";
  };
  var renderArtwork = (options) => options.imageUrl ? h("img", {
    src: options.imageUrl,
    alt: options.title,
    className: options.className
  }) : h(
    "div",
    {
      className: `${options.className} together-artwork--fallback`
    },
    options.fallback
  );
  var renderParticipantSummary = (participant, isSelf, presence) => h(
    "li",
    {
      key: participant.memberId,
      className: "together-member-chip"
    },
    participant.avatarUrl ? h("img", {
      src: participant.avatarUrl,
      alt: participant.name,
      className: "together-member-chip__avatar-image"
    }) : h("div", { className: "together-member-chip__avatar" }, getInitials(participant.name)),
    h(
      "div",
      { className: "together-member-chip__body" },
      h(
        "strong",
        { className: "together-member-chip__name" },
        participant.name,
        isSelf ? " (voc\xEA)" : ""
      ),
      h(
        "span",
        { className: `together-member-chip__meta is-${presence}` },
        presence === "online" ? "online" : presence === "connecting" ? "conectando" : "offline",
        " \u2022 ",
        formatRelativeTime(participant.joinedAt)
      )
    )
  );
  var renderQueueRow = (item, index, addedByName, onRemove) => h(
    "li",
    {
      key: item.id,
      className: "together-queue-row"
    },
    h("span", { className: "together-queue-row__index" }, `${index + 1}`),
    h(
      "div",
      { className: "together-queue-row__track" },
      renderArtwork({
        imageUrl: item.imageUrl,
        title: item.title,
        fallback: getInitials(item.title),
        className: "together-queue-row__art"
      }),
      h(
        "div",
        { className: "together-queue-row__copy" },
        h("strong", { className: "together-queue-row__title" }, item.title),
        h("span", { className: "together-queue-row__artist" }, item.artist)
      )
    ),
    h("span", { className: "together-queue-row__added" }, addedByName ?? "algu\xE9m"),
    h("span", { className: "together-queue-row__duration" }, formatDuration(item.durationMs)),
    h(
      "button",
      {
        className: "together-icon-button together-icon-button--danger",
        onClick: () => onRemove(item.id)
      },
      "x"
    )
  );
  var renderActivity = (activity) => h(
    "li",
    {
      key: activity.id,
      className: "together-log-item"
    },
    h("p", { className: "together-log-item__text" }, activity.description),
    h(
      "div",
      { className: "together-log-item__meta" },
      h("span", null, activity.actorName),
      h("span", null, formatRelativeTime(activity.createdAt))
    )
  );
  var TogetherApp = () => {
    const state = useAppState();
    const [backendDraft, setBackendDraft] = useState(state.backendBaseUrl);
    const [roomCodeDraft, setRoomCodeDraft] = useState("");
    const [clock, setClock] = useState(Date.now());
    useEffect(() => {
      ensureControllers();
      void syncProfileFromSpotify();
    }, []);
    useEffect(() => setBackendDraft(state.backendBaseUrl), [state.backendBaseUrl]);
    useEffect(() => {
      const interval = setInterval(() => setClock(Date.now()), 250);
      return () => clearInterval(interval);
    }, []);
    const currentTrack = state.playback.currentTrack;
    const localTrackUri = Spicetify?.Player?.data?.item?.uri ?? null;
    const derivedPosition = useMemo(() => {
      if (!state.playback.isPlaying) {
        return state.playback.positionMs;
      }
      const elapsed = clock - new Date(state.playback.updatedAt).getTime();
      const duration = state.playback.currentTrack?.durationMs ?? Number.MAX_SAFE_INTEGER;
      return clamp(state.playback.positionMs + elapsed, 0, duration);
    }, [clock, state.playback]);
    const displayPosition = currentTrack?.durationMs && currentTrack.trackUri === localTrackUri ? clamp(Spicetify?.Player?.getProgress?.() ?? derivedPosition, 0, currentTrack.durationMs) : derivedPosition;
    const progressRatio = currentTrack?.durationMs ? clamp(displayPosition / currentTrack.durationMs, 0, 1) : 0;
    const connectedCount = state.participants.filter((participant) => {
      const isSelf = participant.memberId === state.memberId;
      return resolveParticipantPresence(participant, {
        isSelf,
        socketConnected: state.socketConnected,
        connectionStatus: state.connectionStatus
      }) !== "offline";
    }).length;
    const participantNameById = useMemo(
      () => Object.fromEntries(state.participants.map((participant) => [participant.memberId, participant.name])),
      [state.participants]
    );
    const nextUpTrack = state.queue[0] ?? null;
    const copyRoomCode = async () => {
      if (!state.roomCode) {
        notify("Crie ou entre em uma sala antes de copiar o c\xF3digo.", "info");
        return;
      }
      try {
        await navigator.clipboard?.writeText(state.roomCode);
        notify("C\xF3digo da sala copiado.", "success");
      } catch {
        notify("N\xE3o foi poss\xEDvel copiar o c\xF3digo.", "error");
      }
    };
    return h(
      "section",
      { className: "together-shell" },
      h(
        "div",
        { className: "together-dashboard" },
        h(
          "div",
          { className: "together-column together-column--main" },
          h(
            "section",
            { className: "together-panel together-panel--playback" },
            h(
              "div",
              { className: "together-playback-card" },
              renderArtwork({
                imageUrl: currentTrack?.imageUrl ?? null,
                title: currentTrack?.title ?? "Nenhuma faixa",
                fallback: currentTrack ? getInitials(currentTrack.title) : "TG",
                className: "together-playback-card__art"
              }),
              h(
                "div",
                { className: "together-playback-card__body" },
                h("h1", { className: "together-playback-card__title" }, currentTrack?.title ?? "Nenhuma faixa sincronizada"),
                h(
                  "p",
                  { className: "together-playback-card__artist" },
                  currentTrack ? `${currentTrack.artist}${currentTrack.album ? ` \u2022 ${currentTrack.album}` : ""}` : "Crie uma sala ou entre em uma sess\xE3o para sincronizar."
                ),
                h(
                  "div",
                  { className: "together-playback-card__progress" },
                  h("div", {
                    className: "together-playback-card__progress-bar",
                    style: { width: `${progressRatio * 100}%` }
                  })
                ),
                h(
                  "div",
                  { className: "together-playback-card__meta" },
                  h("span", null, currentTrack ? formatDuration(displayPosition) : "--:--"),
                  h("span", null, currentTrack ? formatDuration(currentTrack.durationMs) : "--:--")
                )
              )
            ),
            h(
              "div",
              { className: "together-next-up" },
              h("span", { className: "together-panel__label" }, "A seguir"),
              nextUpTrack ? h(
                "div",
                { className: "together-next-up__track" },
                renderArtwork({
                  imageUrl: nextUpTrack.imageUrl,
                  title: nextUpTrack.title,
                  fallback: getInitials(nextUpTrack.title),
                  className: "together-next-up__art"
                }),
                h(
                  "div",
                  { className: "together-next-up__copy" },
                  h("strong", { className: "together-next-up__title" }, nextUpTrack.title),
                  h("span", { className: "together-next-up__artist" }, nextUpTrack.artist)
                )
              ) : h("span", { className: "together-next-up__empty" }, "Fila vazia")
            )
          ),
          h(
            "section",
            { className: "together-panel together-panel--members" },
            h(
              "div",
              { className: "together-panel__header" },
              h("h2", { className: "together-panel__title" }, "Conectados"),
              h("span", { className: "together-panel__count" }, `${connectedCount}/${state.participants.length || 0}`)
            ),
            state.participants.length ? h(
              "ul",
              { className: "together-member-list" },
              state.participants.map((participant) => {
                const isSelf = participant.memberId === state.memberId;
                return renderParticipantSummary(
                  participant,
                  isSelf,
                  resolveParticipantPresence(participant, {
                    isSelf,
                    socketConnected: state.socketConnected,
                    connectionStatus: state.connectionStatus
                  })
                );
              })
            ) : h("div", { className: "together-empty" }, "Nenhum participante")
          ),
          h(
            "section",
            { className: "together-panel together-panel--queue" },
            h(
              "div",
              { className: "together-panel__header" },
              h("h2", { className: "together-panel__title" }, "Fila"),
              h(
                "div",
                { className: "together-panel__actions" },
                h(
                  "button",
                  {
                    className: "together-button together-button--ghost",
                    onClick: addCurrentTrackToQueue
                  },
                  "Adicionar atual"
                ),
                h(
                  "button",
                  {
                    className: "together-button together-button--primary",
                    onClick: skipNextQueuedTrack
                  },
                  "Puxar pr\xF3xima"
                )
              )
            ),
            h(
              "div",
              { className: "together-queue-head" },
              h("span", null, "#"),
              h("span", null, "T\xEDtulo"),
              h("span", null, "Adicionado por"),
              h("span", null, "Dur."),
              h("span", null, "")
            ),
            state.queue.length ? h(
              "ul",
              { className: "together-queue-list" },
              state.queue.map(
                (item, index) => renderQueueRow(item, index, participantNameById[item.addedBy], removeQueueItem)
              )
            ) : h("div", { className: "together-empty together-empty--queue" }, "Nenhuma faixa na fila")
          )
        ),
        h(
          "div",
          { className: "together-column together-column--session" },
          h(
            "section",
            { className: "together-panel together-panel--session" },
            h(
              "div",
              { className: "together-panel__header" },
              h("h2", { className: "together-panel__title together-panel__title--brand" }, "Together"),
              h(
                "span",
                {
                  className: `together-session-badge ${state.socketConnected ? "is-online" : state.connectionStatus === "connecting" ? "is-busy" : "is-offline"}`
                },
                state.socketConnected ? "Conectado" : state.connectionStatus === "connecting" ? "Conectando" : "Offline"
              )
            ),
            h(
              "div",
              { className: "together-session-copy" },
              h(
                "p",
                null,
                state.roomCode ? "Compartilhe o c\xF3digo da sala para sincronizar com outras pessoas." : "Crie uma nova sala ou entre usando o c\xF3digo. Seu nome do Spotify ser\xE1 usado automaticamente."
              )
            ),
            h(
              "label",
              { className: "together-field" },
              h("span", { className: "together-field__label" }, "C\xF3digo da sala"),
              h("input", {
                value: roomCodeDraft,
                onChange: (event) => setRoomCodeDraft(event.target.value.toUpperCase()),
                placeholder: "ID do amigo",
                className: "together-input"
              })
            ),
            h(
              "div",
              { className: "together-session-actions" },
              h(
                "button",
                {
                  className: "together-button together-button--primary together-button--wide",
                  onClick: () => {
                    if (roomCodeDraft.trim()) {
                      joinRoom(roomCodeDraft);
                      return;
                    }
                    createRoom();
                  }
                },
                roomCodeDraft.trim() ? "Conectar" : "Criar sala"
              ),
              h(
                "button",
                {
                  className: "together-button together-button--ghost",
                  onClick: () => {
                    createRoom();
                  }
                },
                "Nova sala"
              )
            ),
            h(
              "div",
              { className: "together-mini-actions" },
              h(
                "button",
                {
                  className: "together-mini-button",
                  onClick: copyRoomCode
                },
                "Copiar c\xF3digo"
              ),
              h(
                "button",
                {
                  className: "together-mini-button",
                  onClick: reconnectRoom
                },
                "Reconectar"
              ),
              h(
                "button",
                {
                  className: "together-mini-button together-mini-button--danger",
                  onClick: leaveRoom
                },
                "Sair"
              )
            ),
            h(
              "label",
              { className: "together-field together-field--compact" },
              h("span", { className: "together-field__label" }, "Servidor"),
              h("input", {
                value: backendDraft,
                onChange: (event) => setBackendDraft(event.target.value),
                onBlur: () => updateBackendBaseUrl(backendDraft),
                className: "together-input together-input--compact"
              })
            ),
            state.connectionError ? h("p", { className: "together-error" }, state.connectionError) : null
          ),
          h(
            "section",
            { className: "together-panel together-panel--logs" },
            h(
              "div",
              { className: "together-panel__header" },
              h("h2", { className: "together-panel__title" }, "\xDAltimas a\xE7\xF5es"),
              h("span", { className: "together-panel__count" }, `${state.activityLog.length}`)
            ),
            state.activityLog.length ? h("ul", { className: "together-log-list" }, state.activityLog.map(renderActivity)) : h("div", { className: "together-empty together-empty--logs" }, "Nenhum registro")
          )
        )
      )
    );
  };
  function render() {
    ensureControllers();
    return h(TogetherApp, null);
  }
  return __toCommonJS(index_exports);
})();

function render(){return TogetherBundle.render();}

