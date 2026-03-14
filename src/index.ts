import { buildTrackSummary, readInitialPlayback, TogetherPlayerBridge } from "./player";
import type { ConnectionStatus, ParticipantSummary, SessionActivity, SessionQueueItem, SessionTrack } from "./protocol";
import { normalizeRoomCode } from "./protocol";
import { TogetherSessionClient } from "./socket-client";
import { createAppStore, createInitialAppState } from "./state";
import {
  DEFAULT_BACKEND_BASE_URL,
  LOCAL_STORAGE_KEYS,
  clamp,
  formatDuration,
  normalizeBaseUrl,
  readSpicetifyStorage,
  showGlobalNotification,
  writeSpicetifyStorage
} from "./utils";

const react = Spicetify.React;
const h = react.createElement;
const { useEffect, useMemo, useState } = react;

const loadDisplayName = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.displayName) ?? "Spotify listener";
const loadProfileImageUrl = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.profileImageUrl);
const loadBackendBaseUrl = () =>
  normalizeBaseUrl(readSpicetifyStorage(LOCAL_STORAGE_KEYS.backendBaseUrl) ?? DEFAULT_BACKEND_BASE_URL);

const store = createAppStore(createInitialAppState(loadBackendBaseUrl(), loadDisplayName(), loadProfileImageUrl()));

let sessionClient: TogetherSessionClient | null = null;
let playerBridge: TogetherPlayerBridge | null = null;
let initialized = false;
let togetherQueueContextMenuItem: any = null;

const TRACK_URI_PREFIX = "spotify:track:";
const TOGETHER_CONTEXT_MENU_ICON =
  '<path d="M17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-10 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.485 0-4.5 1.79-4.5 4V20h9v-3c0-.728.173-1.415.48-2.023A5.978 5.978 0 0 0 7 13Zm10 0c-.944 0-1.837.218-2.632.607A5.994 5.994 0 0 1 16.5 17v3h5v-3c0-2.21-2.015-4-4.5-4Z"/>';

const isSpotifyTrackUri = (uri: string) => {
  const parsedUri = Spicetify?.URI?.from?.(uri);
  return parsedUri?.type === Spicetify?.URI?.Type?.TRACK || uri.startsWith(TRACK_URI_PREFIX);
};

const extractTrackIdFromUri = (uri: string) => {
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

const ensureControllers = () => {
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

const notify = (message: string, kind: "info" | "success" | "error" = "info") => {
  showGlobalNotification(message, kind);
};

const extractSpotifyAvatarUrl = (user: any) =>
  user?.avatarUrl ??
  user?.imageUrl ??
  user?.images?.[0]?.url ??
  user?.avatar?.url ??
  user?.photo_url ??
  null;

const extractSpotifyDisplayName = (user: any) => user?.displayName ?? user?.display_name ?? user?.name ?? null;

const readSpotifyProfile = async () => {
  let displayName: string | null = null;
  let avatarUrl: string | null = null;

  try {
    const user = await Spicetify.Platform.UserAPI.getUser();
    displayName = extractSpotifyDisplayName(user);
    avatarUrl = extractSpotifyAvatarUrl(user);
  } catch {
    // Ignore UserAPI failures and try the Web API next.
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

const syncProfileFromSpotify = async () => {
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
    // Ignore bootstrap lookup failures.
  }
};

const mapSpotifyTrackToSessionTrack = (track: any): SessionTrack | null => {
  const rawUri = typeof track?.uri === "string" ? track.uri : null;
  const trackId = rawUri ? extractTrackIdFromUri(rawUri) : null;
  if (!rawUri || !trackId) {
    return null;
  }

  const artists = Array.isArray(track?.artists)
    ? track.artists
    : Array.isArray(track?.artists?.items)
      ? track.artists.items
      : [];
  const album = track?.album ?? track?.albumOfTrack ?? null;
  const images = Array.isArray(album?.images)
    ? album.images
    : Array.isArray(track?.images)
      ? track.images
      : Array.isArray(track?.coverArt?.sources)
        ? track.coverArt.sources
        : [];

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

const fetchTrackSummaryByUri = async (uri: string): Promise<SessionTrack | null> => {
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

const fetchTrackSummariesByUris = async (uris: string[]): Promise<SessionTrack[]> => {
  const tracks = await Promise.all(uris.map((uri) => fetchTrackSummaryByUri(uri)));
  return tracks.filter((track): track is SessionTrack => Boolean(track));
};

const addSelectedTracksToTogetherQueue = async (uris: string[]) => {
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
      notify("Não foi possível ler as faixas selecionadas.", "error");
      return;
    }

    tracks.forEach((track) => sessionClient?.addTrackToQueue(track));

    notify(
      tracks.length === 1
        ? `${tracks[0].title} adicionada à fila do Together.`
        : `${tracks.length} faixas adicionadas à fila do Together.`,
      "success"
    );
  } catch (error) {
    notify(error instanceof Error ? error.message : "Não foi possível adicionar à fila do Together.", "error");
  }
};

const ensureQueueContextMenu = () => {
  if (togetherQueueContextMenuItem || !Spicetify?.ContextMenu?.Item) {
    return;
  }

  togetherQueueContextMenuItem = new Spicetify.ContextMenu.Item(
    "Adicionar à fila do Together",
    (uris: string[]) => {
      void addSelectedTracksToTogetherQueue(uris);
    },
    (uris: string[]) => {
      const state = store.getState();
      return Boolean(
        state.roomCode &&
          state.memberId &&
          state.socketConnected &&
          Array.isArray(uris) &&
          uris.length &&
          uris.every((uri) => isSpotifyTrackUri(uri))
      );
    },
    TOGETHER_CONTEXT_MENU_ICON
  );

  togetherQueueContextMenuItem.register();
};

const useAppState = () => {
  const [state, setState] = useState(store.getState());

  useEffect(() => store.subscribe(() => setState(store.getState())), []);

  return state;
};

const updateBackendBaseUrl = (value: string) => {
  const normalized = normalizeBaseUrl(value);
  writeSpicetifyStorage(LOCAL_STORAGE_KEYS.backendBaseUrl, normalized);
  store.setState((state) => ({
    ...state,
    backendBaseUrl: normalized
  }));
};

const createRoom = async () => {
  ensureControllers();
  await syncProfileFromSpotify();

  try {
    await sessionClient?.createRoom(readInitialPlayback() ?? null);
    notify("Sala criada e conectada.", "success");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Não foi possível criar a sala.", "error");
  }
};

const joinRoom = async (roomCode: string) => {
  ensureControllers();
  await syncProfileFromSpotify();

  try {
    await sessionClient?.joinRoom(normalizeRoomCode(roomCode));
    notify("Entrou na sessão.", "success");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Não foi possível entrar na sala.", "error");
  }
};

const reconnectRoom = async () => {
  try {
    await sessionClient?.reconnectCurrentRoom();
    notify("Reconectado ao servidor.", "success");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Reconexão falhou.", "error");
  }
};

const leaveRoom = async () => {
  await sessionClient?.leaveRoom();
  notify("Sessão encerrada neste cliente.", "info");
};

const addCurrentTrackToQueue = () => {
  const track = buildTrackSummary(Spicetify?.Player?.data?.item);
  if (!track) {
    notify("Nenhuma faixa ativa para adicionar.", "error");
    return;
  }

  sessionClient?.addTrackToQueue(track);
};

const removeQueueItem = (itemId: string) => {
  sessionClient?.removeQueueItem(itemId);
};

const skipNextQueuedTrack = () => {
  sessionClient?.skipToNextQueuedTrack();
};

const formatRelativeTime = (isoDate: string) => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
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

const getInitials = (value: string) =>
  value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase() ?? "")
    .join("") || "SP";

type ParticipantPresence = "online" | "connecting" | "offline";

const resolveParticipantPresence = (
  participant: ParticipantSummary,
  options: {
    isSelf: boolean;
    socketConnected: boolean;
    connectionStatus: ConnectionStatus;
  }
): ParticipantPresence => {
  if (participant.isConnected || (options.isSelf && options.socketConnected)) {
    return "online";
  }

  if (options.isSelf && options.connectionStatus === "connecting") {
    return "connecting";
  }

  return "offline";
};

const renderArtwork = (options: {
  imageUrl: string | null;
  title: string;
  fallback: string;
  className: string;
}) =>
  options.imageUrl
    ? h("img", {
        src: options.imageUrl,
        alt: options.title,
        className: options.className
      })
    : h(
        "div",
        {
          className: `${options.className} together-artwork--fallback`
        },
        options.fallback
      );

const renderParticipantSummary = (participant: ParticipantSummary, isSelf: boolean, presence: ParticipantPresence) =>
  h(
    "li",
    {
      key: participant.memberId,
      className: "together-member-chip"
    },
    participant.avatarUrl
      ? h("img", {
          src: participant.avatarUrl,
          alt: participant.name,
          className: "together-member-chip__avatar-image"
        })
      : h("div", { className: "together-member-chip__avatar" }, getInitials(participant.name)),
    h(
      "div",
      { className: "together-member-chip__body" },
      h(
        "strong",
        { className: "together-member-chip__name" },
        participant.name,
        isSelf ? " (você)" : ""
      ),
      h(
        "span",
        { className: `together-member-chip__meta is-${presence}` },
        presence === "online" ? "online" : presence === "connecting" ? "conectando" : "offline",
        " • ",
        formatRelativeTime(participant.joinedAt)
      )
    )
  );

const renderQueueRow = (
  item: SessionQueueItem,
  index: number,
  addedByName: string | undefined,
  onRemove: (itemId: string) => void
) =>
  h(
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
    h("span", { className: "together-queue-row__added" }, addedByName ?? "alguém"),
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

const renderActivity = (activity: SessionActivity) =>
  h(
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

const TogetherApp = () => {
  const state = useAppState() as ReturnType<typeof store.getState>;
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

  const displayPosition =
    currentTrack?.durationMs && currentTrack.trackUri === localTrackUri
      ? clamp(Spicetify?.Player?.getProgress?.() ?? derivedPosition, 0, currentTrack.durationMs)
      : derivedPosition;
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
      notify("Crie ou entre em uma sala antes de copiar o código.", "info");
      return;
    }

    try {
      await navigator.clipboard?.writeText(state.roomCode);
      notify("Código da sala copiado.", "success");
    } catch {
      notify("Não foi possível copiar o código.", "error");
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
                currentTrack
                  ? `${currentTrack.artist}${currentTrack.album ? ` • ${currentTrack.album}` : ""}`
                  : "Crie uma sala ou entre em uma sessão para sincronizar."
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
            nextUpTrack
              ? h(
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
                )
              : h("span", { className: "together-next-up__empty" }, "Fila vazia")
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
          state.participants.length
            ? h(
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
              )
            : h("div", { className: "together-empty" }, "Nenhum participante")
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
                "Puxar próxima"
              )
            )
          ),
          h(
            "div",
            { className: "together-queue-head" },
            h("span", null, "#"),
            h("span", null, "Título"),
            h("span", null, "Adicionado por"),
            h("span", null, "Dur."),
            h("span", null, "")
          ),
          state.queue.length
            ? h(
                "ul",
                { className: "together-queue-list" },
                state.queue.map((item, index) =>
                  renderQueueRow(item, index, participantNameById[item.addedBy], removeQueueItem)
                )
              )
            : h("div", { className: "together-empty together-empty--queue" }, "Nenhuma faixa na fila")
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
                className: `together-session-badge ${
                  state.socketConnected ? "is-online" : state.connectionStatus === "connecting" ? "is-busy" : "is-offline"
                }`
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
              state.roomCode
                ? "Compartilhe o código da sala para sincronizar com outras pessoas."
                : "Crie uma nova sala ou entre usando o código. Seu nome do Spotify será usado automaticamente."
            )
          ),
          h(
            "label",
            { className: "together-field" },
            h("span", { className: "together-field__label" }, "Código da sala"),
            h("input", {
              value: roomCodeDraft,
              onChange: (event: any) => setRoomCodeDraft(event.target.value.toUpperCase()),
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
              "Copiar código"
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
              onChange: (event: any) => setBackendDraft(event.target.value),
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
            h("h2", { className: "together-panel__title" }, "Últimas ações"),
            h("span", { className: "together-panel__count" }, `${state.activityLog.length}`)
          ),
          state.activityLog.length
            ? h("ul", { className: "together-log-list" }, state.activityLog.map(renderActivity))
            : h("div", { className: "together-empty together-empty--logs" }, "Nenhum registro")
        )
      )
    )
  );
};

function render() {
  ensureControllers();
  return h(TogetherApp, null);
}

export { render };
