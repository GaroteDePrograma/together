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
const TRACK_URL_PREFIX = "https://open.spotify.com/track/";
const UNKNOWN_TRACK_TITLE = "Faixa desconhecida";
const UNKNOWN_TRACK_ARTIST = "Artista desconhecido";
const TOGETHER_CONTEXT_MENU_ICON =
  '<path d="M17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-10 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.485 0-4.5 1.79-4.5 4V20h9v-3c0-.728.173-1.415.48-2.023A5.978 5.978 0 0 0 7 13Zm10 0c-.944 0-1.837.218-2.632.607A5.994 5.994 0 0 1 16.5 17v3h5v-3c0-2.21-2.015-4-4.5-4Z"/>';

const extractTrackIdFromUri = (uri: string) => {
  const normalizedUri = uri.trim();
  const parsedUri = Spicetify?.URI?.from?.(normalizedUri);
  if (parsedUri?.type === Spicetify?.URI?.Type?.TRACK && typeof parsedUri.id === "string") {
    return parsedUri.id;
  }

  const matches = [
    /^spotify:track:([A-Za-z0-9]+)(?:[?:#].*)?$/i.exec(normalizedUri),
    /^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)(?:\?.*)?$/i.exec(normalizedUri)
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

const isSpotifyTrackUri = (uri: string) => Boolean(extractTrackIdFromUri(uri));
const buildSpotifyTrackUri = (trackId: string) => `${TRACK_URI_PREFIX}${trackId}`;
type SelectedTrackRef = {
  uri: string;
  uid?: string | null;
  metadata?: Record<string, string> | null;
};

const buildSelectedTrackRefs = (uris: string[], uids?: string[]) =>
  uris
    .filter(isSpotifyTrackUri)
    .map((uri, index) => ({
      uri,
      uid: Array.isArray(uids) ? (uids[index] ?? null) : null
    }));

const getGraphQLVariableNames = (query: any) => {
  const definitions = Array.isArray(query?.definitions) ? query.definitions : [query];
  return definitions
    .flatMap((definition) =>
      Array.isArray(definition?.variableDefinitions)
        ? definition.variableDefinitions.map((variableDefinition: any) => variableDefinition?.variable?.name?.value)
        : []
    )
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
};

const pickGraphQLVariables = (query: any, candidates: Record<string, any>) => {
  const variableNames = new Set(getGraphQLVariableNames(query));
  if (!variableNames.size) {
    return candidates;
  }

  return Object.fromEntries(
    Object.entries(candidates).filter(([key, value]) => {
      if (!variableNames.has(key) || value == null) {
        return false;
      }

      return !Array.isArray(value) || value.length > 0;
    })
  );
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
    sendPlaybackCommand: (command) => sessionClient?.sendPlaybackCommand(command),
    requestQueueAdvance: (expectedTrackUri) => sessionClient?.skipToNextQueuedTrack(expectedTrackUri)
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
    title: track?.name ?? track?.title ?? UNKNOWN_TRACK_TITLE,
    artist: artists[0]?.name ?? artists[0]?.profile?.name ?? track?.artist?.name ?? UNKNOWN_TRACK_ARTIST,
    album: album?.name ?? album?.title ?? null,
    imageUrl: images[0]?.url ?? images[0]?.source ?? null,
    durationMs: Number(
      track?.duration_ms ?? track?.duration?.totalMilliseconds ?? track?.duration?.milliseconds ?? track?.duration ?? 0
    )
  };
};

const isMeaningfulTrackText = (value: string | null | undefined, fallback: string) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== fallback.toLowerCase();

const isMeaningfulTrackSummary = (track: SessionTrack | null): track is SessionTrack =>
  Boolean(
    track &&
      extractTrackIdFromUri(track.trackUri) &&
      isMeaningfulTrackText(track.title, UNKNOWN_TRACK_TITLE)
  );

const mapContextTrackMetadataToSessionTrack = (
  trackRef: Pick<SelectedTrackRef, "uri" | "metadata">,
  metadata?: Record<string, string> | null
): SessionTrack | null => {
  const trackId = extractTrackIdFromUri(trackRef.uri);
  if (!trackId || !metadata) {
    return null;
  }

  const title = metadata.title?.trim();
  const artist = metadata.artist_name?.trim() ?? metadata["artist_name:1"]?.trim() ?? UNKNOWN_TRACK_ARTIST;
  if (!title) {
    return null;
  }

  return {
    trackUri: buildSpotifyTrackUri(trackId),
    title,
    artist,
    album: metadata.album_title?.trim() || null,
    imageUrl:
      metadata.image_xlarge_url ??
      metadata.image_large_url ??
      metadata.image_url ??
      metadata.image_small_url ??
      null,
    durationMs: Number(metadata.duration ?? 0)
  };
};

const resolveCandidateTrackUri = (value: any, trackId: string) => {
  const candidateUris = [
    value?.uri,
    value?.trackUri,
    value?.entityUri,
    value?.linkedFrom?.uri,
    value?.shareUrl
  ];

  for (const candidateUri of candidateUris) {
    if (typeof candidateUri === "string" && extractTrackIdFromUri(candidateUri) === trackId) {
      return buildSpotifyTrackUri(trackId);
    }
  }

  if (typeof value?.id === "string" && value.id === trackId) {
    return buildSpotifyTrackUri(trackId);
  }

  return null;
};

const isTrackCandidateMatch = (value: any, trackId: string) =>
  Boolean(
    value &&
      typeof value === "object" &&
      resolveCandidateTrackUri(value, trackId) &&
      (typeof value?.name === "string" ||
        typeof value?.title === "string" ||
        Array.isArray(value?.artists) ||
        value?.artist ||
        value?.album ||
        value?.albumOfTrack ||
        value?.duration_ms ||
        value?.duration)
  );

const findTrackCandidate = (value: any, trackId: string, visited = new Set<any>()): any | null => {
  if (!value || typeof value !== "object" || visited.has(value)) {
    return null;
  }

  visited.add(value);
  if (isTrackCandidateMatch(value, trackId)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findTrackCandidate(item, trackId, visited);
      if (match) {
        return match;
      }
    }

    return null;
  }

  for (const nestedValue of Object.values(value)) {
    const match = findTrackCandidate(nestedValue, trackId, visited);
    if (match) {
      return match;
    }
  }

  return null;
};

const summarizeTrackCandidate = (value: any, trackId: string): SessionTrack | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const artist = typeof value?.artist === "string" ? { name: value.artist } : value?.artist;
  const normalizedCandidate = {
    ...value,
    uri: resolveCandidateTrackUri(value, trackId) ?? buildSpotifyTrackUri(trackId),
    name: value?.name ?? value?.title ?? value?.track?.name,
    artist,
    artists: Array.isArray(value?.artists)
      ? value.artists
      : Array.isArray(value?.artists?.items)
        ? value.artists.items
        : Array.isArray(value?.track?.artists)
          ? value.track.artists
          : artist
            ? [artist]
            : [],
    album: value?.album ?? value?.albumOfTrack ?? value?.track?.album ?? value?.release ?? null,
    images:
      value?.images ??
      value?.track?.images ??
      value?.album?.images ??
      value?.albumOfTrack?.images ??
      value?.coverArt?.sources ??
      value?.albumOfTrack?.coverArt?.sources ??
      [],
    duration_ms:
      value?.duration_ms ??
      value?.track?.duration_ms ??
      value?.duration?.totalMilliseconds ??
      value?.duration?.milliseconds ??
      value?.duration ??
      value?.track?.duration ??
      0
  };

  const summary = buildTrackSummary(normalizedCandidate) ?? mapSpotifyTrackToSessionTrack(normalizedCandidate);
  return isMeaningfulTrackSummary(summary) ? summary : null;
};

const describeResponseShape = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 12) : typeof value;

const resolveTrackSummaryFromResponse = (value: any, trackId: string) =>
  summarizeTrackCandidate(value, trackId) ?? summarizeTrackCandidate(findTrackCandidate(value, trackId), trackId);

const isDecoratedContextTrackCandidate = (value: any): value is SelectedTrackRef =>
  Boolean(
    value &&
      typeof value === "object" &&
      typeof value.uri === "string" &&
      isSpotifyTrackUri(value.uri) &&
      value.metadata &&
      typeof value.metadata === "object"
  );

const findDecoratedContextTracks = (value: any, visited = new Set<any>()): SelectedTrackRef[] => {
  if (!value || typeof value !== "object" || visited.has(value)) {
    return [];
  }

  visited.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => findDecoratedContextTracks(item, visited));
  }

  const matches = isDecoratedContextTrackCandidate(value) ? [value] : [];
  return matches.concat(Object.values(value).flatMap((nestedValue) => findDecoratedContextTracks(nestedValue, visited)));
};

const fetchTrackSummariesFromDecoratedContext = async (
  trackRefs: SelectedTrackRef[],
  contextUri?: string
): Promise<SessionTrack[]> => {
  const query = Spicetify?.GraphQL?.Definitions?.decorateContextTracks;
  const request = Spicetify?.GraphQL?.Request;
  if (!query || !request || !trackRefs.length) {
    return [];
  }

  const contextTracks = trackRefs.map(({ uri, uid }) => ({
    uri,
    ...(uid ? { uid } : {})
  }));
  const variableCandidates = [
    pickGraphQLVariables(query, {
      tracks: contextTracks,
      contextTracks,
      ...(contextUri ? { contextUri } : {}),
      ...(contextUri ? { contextURI: contextUri } : {}),
      ...(contextUri ? { context: contextUri } : {}),
      market: Spicetify?.GraphQL?.Context?.market,
      locale: Spicetify?.Locale?.getLocale?.()
    }),
    pickGraphQLVariables(query, {
      uris: contextTracks.map((track) => track.uri),
      uids: contextTracks.map((track) => track.uid).filter((uid): uid is string => Boolean(uid)),
      ...(contextUri ? { contextUri } : {}),
      ...(contextUri ? { contextURI: contextUri } : {}),
      ...(contextUri ? { context: contextUri } : {}),
      market: Spicetify?.GraphQL?.Context?.market,
      locale: Spicetify?.Locale?.getLocale?.()
    }),
    pickGraphQLVariables(query, {
      tracks: contextTracks,
      contextTracks,
      market: Spicetify?.GraphQL?.Context?.market,
      locale: Spicetify?.Locale?.getLocale?.()
    })
  ].filter((variables) => Object.keys(variables).length > 0);

  for (const variables of variableCandidates) {
    try {
      const response = await request(query, variables);
      const decoratedTracks = findDecoratedContextTracks(response);
      const summaries = decoratedTracks
        .map((track) => mapContextTrackMetadataToSessionTrack(track, track.metadata))
        .filter(isMeaningfulTrackSummary);

      if (summaries.length) {
        const summariesById = new Map(summaries.map((summary) => [extractTrackIdFromUri(summary.trackUri), summary] as const));
        return trackRefs
          .map((trackRef) => {
            const trackId = extractTrackIdFromUri(trackRef.uri);
            return trackId ? (summariesById.get(trackId) ?? null) : null;
          })
          .filter(isMeaningfulTrackSummary);
      }
    } catch (error) {
      console.warn("[Together] Falha ao decorar faixas do contexto.", {
        contextUri,
        variables: Object.keys(variables),
        error
      });
    }
  }

  return [];
};

const fetchTrackSummaryFromOEmbed = async (trackId: string): Promise<SessionTrack | null> => {
  const trackUrl = `${TRACK_URL_PREFIX}${trackId}`;

  try {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`);
    if (!response.ok) {
      throw new Error(`Spotify oEmbed respondeu com status ${response.status}.`);
    }

    const payload = await response.json();
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const artist = typeof payload?.author_name === "string" ? payload.author_name.trim() : UNKNOWN_TRACK_ARTIST;
    if (!title) {
      console.warn("[Together] Spotify oEmbed retornou payload sem metadados suficientes.", {
        trackId,
        responseKeys: describeResponseShape(payload)
      });
      return null;
    }

    return {
      trackUri: buildSpotifyTrackUri(trackId),
      title,
      artist,
      album: null,
      imageUrl: typeof payload?.thumbnail_url === "string" ? payload.thumbnail_url : null,
      durationMs: 0
    };
  } catch (error) {
    console.warn("[Together] Falha ao carregar metadados via Spotify oEmbed.", { trackId, error });
    return null;
  }
};

const fetchTrackSummaryFromGraphQL = async (trackId: string): Promise<SessionTrack | null> => {
  const request = Spicetify?.GraphQL?.Request;
  const defs = Spicetify?.GraphQL?.Definitions || {};
  if (!request) return null;

  const queries = [
    defs.getTrack,
    defs.track,
    defs.browseTrack,
    defs.fetchTrack,
    defs.getTrackParsed,
    defs.Track
  ].filter(Boolean);

  if (!queries.length) {
    const keys = Object.keys(defs).filter(k => k.toLowerCase().includes("track"));
    notify(`Sem queries GraphQL conhecidas. Temos: ${keys.slice(0, 10).join(", ")}`, "error");
    return null;
  }

  for (const query of queries) {
    try {
      const response = await request(
        query,
        pickGraphQLVariables(query, {
          uri: buildSpotifyTrackUri(trackId),
          market: Spicetify?.GraphQL?.Context?.market,
          locale: Spicetify?.Locale?.getLocale?.()
        })
      );
      const summary = resolveTrackSummaryFromResponse(response, trackId);
      if (summary) return summary;
    } catch (error) {
       // ignore query failure, try next
    }
  }

  return null;
};

const fetchTrackSummaryFromOfficialToken = async (uri: string, trackId: string): Promise<SessionTrack | null> => {
  try {
    const tokenProv = (Spicetify?.Platform?.AuthorizationAPI as any)?._tokenProvider || (Spicetify?.Platform?.AuthorizationAPI as any)?._session;
    const token = typeof tokenProv?.getToken === "function" ? (await tokenProv.getToken())?.accessToken : tokenProv?.accessToken;

    if (token) {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const response = await res.json();
        const summary = resolveTrackSummaryFromResponse(response, trackId);
        if (summary) return summary;
      }
    }
  } catch (error) {
    // ignore
  }
  return null;
};

const fetchTrackSummaryByUri = async (uri: string): Promise<SessionTrack | null> => {
  const trackId = extractTrackIdFromUri(uri);
  if (!trackId) return null;

  return (
    (await fetchTrackSummaryFromGraphQL(trackId)) ??
    (await fetchTrackSummaryFromOfficialToken(uri, trackId)) ??
    (await fetchTrackSummaryFromOEmbed(trackId))
  );
};

const fetchTrackSummariesBySelection = async (
  uris: string[],
  uids?: string[],
  contextUri?: string
): Promise<SessionTrack[]> => {
  const trackRefs = buildSelectedTrackRefs(uris, uids);
  if (!trackRefs.length) {
    return [];
  }

  const decoratedTracks = await fetchTrackSummariesFromDecoratedContext(trackRefs, contextUri);
  const decoratedTrackIds = new Set(
    decoratedTracks
      .map((track) => extractTrackIdFromUri(track.trackUri))
      .filter((trackId): trackId is string => Boolean(trackId))
  );

  const missingTrackRefs = trackRefs.filter((trackRef) => {
    const trackId = extractTrackIdFromUri(trackRef.uri);
    return !trackId || !decoratedTrackIds.has(trackId);
  });

  if (!missingTrackRefs.length) {
    return decoratedTracks;
  }

  const fallbackTracks = await Promise.all(missingTrackRefs.map((trackRef) => fetchTrackSummaryByUri(trackRef.uri)));
  return decoratedTracks.concat(fallbackTracks.filter(isMeaningfulTrackSummary));
};

const addSelectedTracksToTogetherQueue = async (uris: string[], uids?: string[], contextUri?: string) => {
  ensureControllers();

  const state = store.getState();
  if (!state.roomCode || !state.memberId || !state.socketConnected) {
    notify("Entre em uma sala do Together antes de adicionar faixas.", "info");
    return;
  }

  const trackRefs = buildSelectedTrackRefs(uris, uids);
  if (!trackRefs.length) {
    notify("Selecione pelo menos uma faixa do Spotify.", "info");
    return;
  }

  try {
    const tracks = await fetchTrackSummariesBySelection(
      trackRefs.map((trackRef) => trackRef.uri),
      trackRefs.map((trackRef) => trackRef.uid ?? ""),
      contextUri
    );
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
    (uris: string[], uids?: string[], contextUri?: string) => {
      void addSelectedTracksToTogetherQueue(uris, uids, contextUri);
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

const TOGETHER_VERSION = process.env.TOGETHER_VERSION || "v1.0.0-dev";

const useUpdateCheck = () => {
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch("https://api.github.com/repos/GaroteDePrograma/together/releases/latest")
      .then(r => r.json())
      .then(release => {
        if (release.tag_name && release.tag_name !== TOGETHER_VERSION && !release.draft) {
          setUpdateUrl(release.html_url);
          setNewVersion(release.tag_name);
        }
      })
      .catch(() => {});
  }, []);

  return { updateUrl, newVersion };
};

const TogetherApp = () => {
  const state = useAppState() as ReturnType<typeof store.getState>;
  const { updateUrl, newVersion } = useUpdateCheck();
  const [backendDraft, setBackendDraft] = useState(state.backendBaseUrl);
  const [roomCodeDraft, setRoomCodeDraft] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [lastCopiedAt, setLastCopiedAt] = useState(0);

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
  const roomCodeWasCopied = Boolean(state.roomCode) && clock - lastCopiedAt < 1800;
  const isInRoom = Boolean(state.roomCode);
  const canReconnectRoom = isInRoom && !state.socketConnected && state.connectionStatus !== "connecting";

  const copyRoomCode = async () => {
    if (!state.roomCode) {
      notify("Crie ou entre em uma sala antes de copiar o código.", "info");
      return;
    }

    try {
      await navigator.clipboard?.writeText(state.roomCode);
      setLastCopiedAt(Date.now());
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
        updateUrl && newVersion
          ? h(
              "section",
              {
                className: "together-panel",
                style: { backgroundColor: "rgba(255, 100, 100, 0.2)", cursor: "pointer", marginBottom: "1rem" },
                onClick: () => window.open(updateUrl, "_blank")
              },
              h(
                "div",
                { className: "together-panel__header", style: { borderBottom: "none", marginBottom: 0 } },
                h("h2", { className: "together-panel__title", style: { color: "#fff" } }, `Nova versão ${newVersion} Disponível!`),
                h("span", { className: "together-panel__count", style: { color: "#fff", padding: "4px 8px", background: "rgba(255,255,255,0.2)", borderRadius: "4px" } }, "Baixar no GitHub")
              ),
              h("p", { style: { marginTop: "4px", color: "rgba(255,255,255,0.8)" } }, "Devido a restrições de segurança do Spotify, não é possível instalar automaticamente arquivos no seu PC. Clique aqui para baixar a nova versão.")
            )
          : null,
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
            h("h2", { className: "together-panel__title" }, "Conectados")
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
          state.roomCode
            ? h(
                "button",
                {
                  className: `together-room-code-card${roomCodeWasCopied ? " is-copied" : ""}`,
                  onClick: copyRoomCode,
                  type: "button",
                  title: "Copiar código da sala"
                },
                h("span", { className: "together-room-code-card__label" }, "Código da sala"),
                h("strong", { className: "together-room-code-card__value" }, state.roomCode),
                h(
                  "span",
                  { className: "together-room-code-card__hint" },
                  roomCodeWasCopied ? "Copiado" : "Clique para copiar"
                )
              )
            : null,
          !isInRoom
            ? h(
                react.Fragment,
                null,
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
                      type: "button",
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
                      type: "button",
                      onClick: () => {
                        createRoom();
                      }
                    },
                    "Nova sala"
                  )
                )
              )
            : null,
          isInRoom
            ? h(
                "div",
                { className: "together-mini-actions" },
                canReconnectRoom
                  ? h(
                      "button",
                      {
                        className: "together-mini-button",
                        onClick: reconnectRoom,
                        type: "button"
                      },
                      "Reconectar"
                    )
                  : null,
                h(
                  "button",
                  {
                    className: "together-mini-button together-mini-button--danger",
                    onClick: leaveRoom,
                    type: "button"
                  },
                  "Sair da sala"
                )
              )
            : null,
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
