import type { AppStore } from "./state";
import type { InitialPlaybackStateInput, PlaybackCommand, PlaybackCommandType, PlaybackState, SessionTrack } from "./protocol";
import { SEEK_DETECTION_TOLERANCE_MS, SEEK_SYNC_THRESHOLD_MS, clamp, createId, wait } from "./utils";

const safePlayerProgress = () => Spicetify?.Player?.getProgress?.() ?? 0;
const safePlayerIsPlaying = () => Boolean(Spicetify?.Player?.isPlaying?.());
const AUTO_PULL_PROGRESS_TRIGGER_MS = 900;
const ARTIST_URI_PREFIX = "spotify:artist:";

const normalizeArtistUri = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalizedValue = value.trim();
  if (normalizedValue.startsWith(ARTIST_URI_PREFIX)) {
    return normalizedValue;
  }

  const match = /^https?:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]+)(?:\?.*)?$/i.exec(normalizedValue);
  return match?.[1] ? `${ARTIST_URI_PREFIX}${match[1]}` : null;
};

const getMetadataArtistUri = (metadata: Record<string, unknown> | null | undefined) => {
  if (!metadata) {
    return null;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (/^artist_uri(?::\d+)?$/i.test(key)) {
      const artistUri = normalizeArtistUri(value);
      if (artistUri) {
        return artistUri;
      }
    }
  }

  return null;
};

const resolveArtistUri = (artist: any, metadata?: Record<string, unknown> | null) =>
  normalizeArtistUri(artist?.uri) ??
  normalizeArtistUri(artist?.profile?.uri) ??
  (typeof artist?.id === "string" && artist.id.length ? `${ARTIST_URI_PREFIX}${artist.id}` : null) ??
  getMetadataArtistUri(metadata);

export const buildTrackSummary = (playerItem: any): SessionTrack | null => {
  if (!playerItem?.uri) {
    return null;
  }

  const artists = Array.isArray(playerItem.artists) 
    ? playerItem.artists 
    : Array.isArray(playerItem.artists?.items) 
      ? playerItem.artists.items 
      : Array.isArray(playerItem.firstArtist?.items)
        ? playerItem.firstArtist.items
        : playerItem.artists ? [playerItem.artists] : [];

  const firstArtist = artists[0] ?? playerItem.artist ?? playerItem.firstArtist;
  const images = playerItem.album?.images ?? playerItem.images ?? [];
  const metadata =
    playerItem?.metadata && typeof playerItem.metadata === "object" ? (playerItem.metadata as Record<string, unknown>) : null;

  return {
    trackUri: playerItem.uri,
    artistUri: resolveArtistUri(firstArtist, metadata),
    title: playerItem.name ?? playerItem.title ?? "Faixa desconhecida",
    artist: firstArtist?.name ?? firstArtist?.profile?.name ?? playerItem.artist?.name ?? "Artista desconhecido",
    album: playerItem.album?.name ?? null,
    imageUrl: images[0]?.url ?? null,
    durationMs: Number(playerItem.duration?.milliseconds ?? playerItem.duration_ms ?? playerItem.duration ?? 0)
  };
};

export const readInitialPlayback = (): InitialPlaybackStateInput | null => {
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

export const buildPlaybackCommand = (
  type: PlaybackCommandType,
  actorId: string,
  options: {
    track?: SessionTrack | null;
    positionMs?: number | null;
    isPlaying?: boolean | null;
    observedPreviousTrackUri?: string | null;
  } = {}
): PlaybackCommand => ({
  commandId: createId("command"),
  actorId,
  type,
  clientObservedAt: new Date().toISOString(),
  track: options.track ?? null,
  positionMs: options.positionMs ?? null,
  isPlaying: options.isPlaying ?? null,
  observedPreviousTrackUri: options.observedPreviousTrackUri ?? null
});

export const shouldPublishSeek = (
  previousPositionMs: number,
  nextPositionMs: number,
  elapsedMs: number,
  toleranceMs: number = SEEK_DETECTION_TOLERANCE_MS
) => {
  const observedDelta = Math.abs((nextPositionMs - previousPositionMs) - elapsedMs);
  return observedDelta > toleranceMs;
};

export const estimatePlaybackPositionMs = (options: {
  sampledProgressMs: number;
  sampledAtMs: number;
  nowMs: number;
  isPlaying: boolean;
  durationMs?: number;
}) => {
  const elapsedMs = options.isPlaying ? Math.max(0, options.nowMs - options.sampledAtMs) : 0;
  return clamp(options.sampledProgressMs + elapsedMs, 0, options.durationMs ?? Number.MAX_SAFE_INTEGER);
};

export const isImmediateNextTrack = (
  nextTracks: Array<{ uri?: string | null } | null | undefined> | null | undefined,
  targetTrackUri: string
) => nextTracks?.[0]?.uri === targetTrackUri;

export const shouldRequestQueuedAdvanceFromProgress = (options: {
  currentTrack: SessionTrack | null;
  localTrackUri: string | null;
  queueLength: number;
  currentProgressMs: number;
}) => {
  const { currentTrack, localTrackUri, queueLength, currentProgressMs } = options;
  if (!currentTrack || queueLength < 1 || currentTrack.durationMs <= 0) {
    return false;
  }

  if (localTrackUri !== currentTrack.trackUri) {
    return false;
  }

  const remainingMs = currentTrack.durationMs - currentProgressMs;
  return remainingMs <= AUTO_PULL_PROGRESS_TRIGGER_MS;
};

interface PlayerBridgeOptions {
  store: AppStore;
  getActorId: () => string | null;
  canPublishEvents: () => boolean;
  sendPlaybackCommand: (command: PlaybackCommand) => void;
  requestQueueAdvance: (expectedTrackUri: string) => void;
}

export class TogetherPlayerBridge {
  private readonly store: AppStore;
  private readonly getActorId: () => string | null;
  private readonly canPublishEvents: () => boolean;
  private readonly sendPlaybackCommand: (command: PlaybackCommand) => void;
  private readonly requestQueueAdvance: (expectedTrackUri: string) => void;
  private started = false;
  private lastProgressSampleMs = 0;
  private lastProgressSampleAt = Date.now();
  private lastAppliedPlaybackVersion = 0;
  private autoAdvanceRequestedTrackUri: string | null = null;
  private suppressedUntil = {
    songchange: 0,
    playpause: 0,
    progress: 0
  };

  constructor(options: PlayerBridgeOptions) {
    this.store = options.store;
    this.getActorId = options.getActorId;
    this.canPublishEvents = options.canPublishEvents;
    this.sendPlaybackCommand = options.sendPlaybackCommand;
    this.requestQueueAdvance = options.requestQueueAdvance;
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

  private isSuppressed(kind: keyof TogetherPlayerBridge["suppressedUntil"]) {
    return Date.now() < this.suppressedUntil[kind];
  }

  private suppress(kind: keyof TogetherPlayerBridge["suppressedUntil"], durationMs: number) {
    this.suppressedUntil[kind] = Math.max(this.suppressedUntil[kind], Date.now() + durationMs);
  }

  private suppressAll(durationMs: number) {
    this.suppress("songchange", durationMs);
    this.suppress("playpause", durationMs);
    this.suppress("progress", durationMs);
  }

  private emitCommand(type: PlaybackCommandType, options: Parameters<typeof buildPlaybackCommand>[2] = {}) {
    if (!this.started || !this.canPublishEvents()) {
      return;
    }

    const actorId = this.getActorId();
    if (!actorId) {
      return;
    }

    this.sendPlaybackCommand(buildPlaybackCommand(type, actorId, options));
  }

  private handleSongChange = () => {
    const now = Date.now();
    const previousProgressMs = this.lastProgressSampleMs;
    const previousProgressSampleAt = this.lastProgressSampleAt;
    const nextProgressMs = safePlayerProgress();
    this.lastProgressSampleAt = now;
    this.lastProgressSampleMs = nextProgressMs;

    if (this.isSuppressed("songchange")) {
      return;
    }

    const state = this.store.getState();
    const previousTrack = state.playback.currentTrack;
    const track = buildTrackSummary(Spicetify?.Player?.data?.item);
    if (!track) {
      return;
    }

    this.emitCommand("SET_TRACK", {
      track,
      positionMs: nextProgressMs,
      isPlaying: true, // We changed the track, it should start immediately for everyone
      observedPreviousTrackUri: previousTrack?.trackUri ?? null
    });
  };

  private handlePlayPause = () => {
    if (this.isSuppressed("playpause")) {
      return;
    }

    this.emitCommand(safePlayerIsPlaying() ? "PLAY" : "PAUSE", {
      positionMs: safePlayerProgress(),
      isPlaying: safePlayerIsPlaying()
    });
  };

  private handleProgress = () => {
    const currentProgress = safePlayerProgress();
    const now = Date.now();
    const state = this.store.getState();

    if (!this.isSuppressed("progress")) {
      if (shouldPublishSeek(this.lastProgressSampleMs, currentProgress, now - this.lastProgressSampleAt)) {
        this.emitCommand("SEEK", {
          positionMs: currentProgress
        });
      }

      const currentTrack = state.playback.currentTrack;
      if (
        currentTrack &&
        this.autoAdvanceRequestedTrackUri !== currentTrack.trackUri &&
        shouldRequestQueuedAdvanceFromProgress({
          currentTrack,
          localTrackUri: Spicetify?.Player?.data?.item?.uri ?? null,
          queueLength: state.queue.length,
          currentProgressMs: currentProgress
        })
      ) {
        this.autoAdvanceRequestedTrackUri = currentTrack.trackUri;
        this.requestQueueAdvance(currentTrack.trackUri);
      }
    }

    this.lastProgressSampleMs = currentProgress;
    this.lastProgressSampleAt = now;
  };

  async syncPlaybackState(playback: PlaybackState) {
    if (playback.version <= this.lastAppliedPlaybackVersion) {
      return;
    }

    this.lastAppliedPlaybackVersion = playback.version;
    this.suppressAll(2000);

     if (
      !playback.currentTrack ||
      playback.currentTrack.trackUri !== this.autoAdvanceRequestedTrackUri ||
      playback.positionMs < playback.currentTrack.durationMs - AUTO_PULL_PROGRESS_TRIGGER_MS
    ) {
      this.autoAdvanceRequestedTrackUri = null;
    }

    const targetTrack = playback.currentTrack;
    const currentTrackUri = Spicetify?.Player?.data?.item?.uri ?? null;

    if (targetTrack?.trackUri && currentTrackUri !== targetTrack.trackUri) {
      if (
        Spicetify?.Platform?.PlayerAPI?.skipToNext &&
        isImmediateNextTrack(Spicetify?.Queue?.nextTracks, targetTrack.trackUri)
      ) {
        await Spicetify.Player.skipToNext();
      } else {
        await Spicetify.Player.playUri(targetTrack.trackUri);
      }
      await wait(180);
    }

    const currentProgress = safePlayerProgress();
    
    let targetPositionMs = playback.positionMs;
    if (playback.isPlaying && playback.updatedAt) {
      const elapsedMs = Date.now() - new Date(playback.updatedAt).getTime();
      if (elapsedMs > 0 && !Number.isNaN(elapsedMs)) {
        targetPositionMs += elapsedMs;
      }
    }

    if (Math.abs(currentProgress - targetPositionMs) > SEEK_SYNC_THRESHOLD_MS) {
      Spicetify.Player.seek(targetPositionMs);
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
}
