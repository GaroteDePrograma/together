import type { AppStore } from "./state";
import type { InitialPlaybackStateInput, PlaybackCommand, PlaybackCommandType, PlaybackState, SessionTrack } from "./protocol";
import { SEEK_DETECTION_TOLERANCE_MS, SEEK_SYNC_THRESHOLD_MS, createId, wait } from "./utils";

const safePlayerProgress = () => Spicetify?.Player?.getProgress?.() ?? 0;
const safePlayerIsPlaying = () => Boolean(Spicetify?.Player?.isPlaying?.());

export const buildTrackSummary = (playerItem: any): SessionTrack | null => {
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
  } = {}
): PlaybackCommand => ({
  commandId: createId("command"),
  actorId,
  type,
  clientObservedAt: new Date().toISOString(),
  track: options.track ?? null,
  positionMs: options.positionMs ?? null,
  isPlaying: options.isPlaying ?? null
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

interface PlayerBridgeOptions {
  store: AppStore;
  getActorId: () => string | null;
  canPublishEvents: () => boolean;
  sendPlaybackCommand: (command: PlaybackCommand) => void;
}

export class TogetherPlayerBridge {
  private readonly store: AppStore;
  private readonly getActorId: () => string | null;
  private readonly canPublishEvents: () => boolean;
  private readonly sendPlaybackCommand: (command: PlaybackCommand) => void;
  private started = false;
  private lastProgressSampleMs = 0;
  private lastProgressSampleAt = Date.now();
  private lastAppliedPlaybackVersion = 0;
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

  async syncPlaybackState(playback: PlaybackState) {
    if (playback.version <= this.lastAppliedPlaybackVersion) {
      return;
    }

    this.lastAppliedPlaybackVersion = playback.version;
    this.suppressAll(2000);

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
}
