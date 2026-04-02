import { buildTrackSummary, readInitialPlayback, TogetherPlayerBridge } from "./player";
import { buildLyricsLookupUrl, fetchTrackLyrics, findActiveLyricsLineIndex } from "./lyrics";
import type {
  ConnectionStatus,
  ParticipantSummary,
  SessionActivity,
  SessionQueueItem,
  SessionTrack,
  TrackLyricsPayload
} from "./protocol";
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
const { useEffect, useMemo, useRef, useState } = react;

const loadDisplayName = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.displayName) ?? "Spotify listener";
const loadProfileImageUrl = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.profileImageUrl);
const loadProfileUri = () => readSpicetifyStorage(LOCAL_STORAGE_KEYS.profileUri);
const loadBackendBaseUrl = () =>
  normalizeBaseUrl(readSpicetifyStorage(LOCAL_STORAGE_KEYS.backendBaseUrl) ?? DEFAULT_BACKEND_BASE_URL);

const store = createAppStore(
  createInitialAppState(loadBackendBaseUrl(), loadDisplayName(), loadProfileImageUrl(), loadProfileUri())
);

let sessionClient: TogetherSessionClient | null = null;
let playerBridge: TogetherPlayerBridge | null = null;
let initialized = false;
let togetherQueueContextMenuItem: any = null;

const TRACK_URI_PREFIX = "spotify:track:";
const TRACK_URL_PREFIX = "https://open.spotify.com/track/";
const ARTIST_URI_PREFIX = "spotify:artist:";
const ARTIST_URL_PREFIX = "https://open.spotify.com/artist/";
const USER_URI_PREFIX = "spotify:user:";
const USER_URL_PREFIX = "https://open.spotify.com/user/";
const SEARCH_URL_PREFIX = "https://open.spotify.com/search/";
const UNKNOWN_TRACK_TITLE = "Faixa desconhecida";
const UNKNOWN_TRACK_ARTIST = "Artista desconhecido";
const TOGETHER_CONTEXT_MENU_ICON =
  '<svg viewBox="0 0 804 642" style="width:16px;height:16px;fill:currentColor;"><path fill-rule="evenodd" clip-rule="evenodd" d="M656.302 2.55144C634.695 9.77044 613.863 19.9364 581.502 39.0534C557.009 53.5234 534.973 65.0224 522.802 69.6854C508.791 75.0524 487.09 76.9894 441.302 76.9584C395.849 76.9284 374.402 80.0524 350.302 90.2124C339.259 94.8684 318.794 105.392 315.054 108.339C302.498 118.232 294.226 126.308 290.802 132.019C284.497 142.535 282.204 149.162 280.1 162.958C276.356 187.496 274.844 208.403 274.822 235.958C274.8 263.457 275.986 281.558 279.835 312.458C280.521 317.967 283.868 327.568 285.962 330.037C286.699 330.905 287.302 332.065 287.302 332.614C287.302 333.164 290.494 336.806 294.396 340.707C308.412 354.723 330.797 362.07 346.686 357.87C360.639 354.181 361.767 353.654 366.883 348.416C372.548 342.617 379.471 329.545 381.161 321.458C381.736 318.708 382.72 313.983 383.348 310.958C384.096 307.354 384.29 299.425 383.911 287.958C381.854 225.771 381.868 225.138 385.581 211.27C386.959 206.121 388.908 205.016 401.302 202.354C406.609 201.214 425.446 200.958 503.975 200.958C567.297 200.958 601.969 201.318 605.476 202.011C608.405 202.591 613.052 203.509 615.802 204.053C627.233 206.313 639.909 210.507 651.721 215.939C659.378 219.459 666.346 228.529 669.021 238.458C671.773 248.668 672.302 252.808 672.302 264.109C672.302 278.188 674.059 293.856 675.858 295.825C677.333 297.438 682.199 296.486 696.802 291.725C711.335 286.987 742.541 271.101 757.512 260.819C759.002 259.795 760.448 258.958 760.726 258.958C761.004 258.958 764.547 256.945 768.599 254.485C772.651 252.025 782.178 246.996 789.771 243.31L803.575 236.608L803.01 227.889C802.7 223.093 801.928 217.209 801.295 214.814C798.506 204.26 797.942 202.233 796.749 198.458C793.927 189.531 789.953 179.983 784.7 169.508C778.624 157.391 778.939 157.962 771.802 146.122C769.052 141.56 766.347 137.07 765.79 136.143C763.899 132.996 760.95 128.486 745.723 105.458C737.358 92.8084 727.981 78.1834 724.885 72.9584C721.789 67.7334 718.929 62.9634 718.529 62.3584C718.129 61.7524 716.467 59.2774 714.835 56.8584C713.203 54.4384 711.122 51.1084 710.211 49.4584C709.299 47.8084 707.611 44.8834 706.46 42.9584C705.309 41.0334 703.481 37.6584 702.399 35.4584C697.466 25.4294 686.32 10.8944 680.01 6.26344C669.896 -1.16056 668.205 -1.42556 656.302 2.55144ZM657.237 61.2084C658.015 62.4454 659.918 65.8564 661.465 68.7874C663.012 71.7184 665.184 75.3874 666.29 76.9414C667.397 78.4954 668.302 80.0024 668.302 80.2894C668.302 80.5764 670.552 84.2094 673.302 88.3614C676.052 92.5144 678.302 96.1794 678.302 96.5054C678.302 96.8314 679.585 98.9794 681.154 101.278C682.722 103.577 684.185 105.918 684.404 106.481C684.623 107.044 693.24 120.196 703.552 135.709C713.865 151.221 722.302 164.126 722.302 164.386C722.302 164.645 723.652 166.858 725.302 169.303C726.952 171.748 728.302 174.052 728.302 174.423C728.302 174.794 729.567 176.979 731.114 179.278C734.271 183.971 740.155 195.83 743.186 203.606C745.044 208.373 745.067 208.796 743.497 209.328C741.727 209.929 737.266 212.441 732.956 215.265C731.566 216.176 728.797 217.837 726.802 218.958C724.807 220.079 722.135 221.676 720.865 222.509C718.598 223.994 718.534 223.935 717.354 219.251C715.499 211.883 711.399 204.278 703.79 194.088C698.481 186.979 694.684 183.17 687.814 178.06C682.857 174.374 677.227 170.641 675.302 169.766C673.377 168.89 669.269 167.031 666.174 165.635C655.121 160.65 628.795 153.78 608.302 150.534C598.933 149.05 587.25 148.903 499.802 149.167L401.802 149.462L386.591 153.187C378.225 155.235 369.225 157.916 366.591 159.143C353.788 165.111 342.486 176.728 338.988 187.515C338.106 190.233 335.939 198.533 334.171 205.958C331.053 219.057 330.956 220.141 330.894 242.458C330.858 255.108 331.171 274.458 331.589 285.458C332.303 304.233 331.504 309.248 329.918 295.958C326.283 265.509 325.496 231.042 327.79 202.787C330.08 174.581 331.663 164.881 334.734 160.24C339.955 152.35 352.278 145.097 377.451 135.098C388.724 130.619 406.185 128.958 442.009 128.956C482.53 128.954 506.368 127.011 526.302 122.086C534.827 119.98 544.052 117.25 546.802 116.02C554.562 112.548 579.29 100.196 584.302 97.2874C590.772 93.5324 600.467 87.9894 606.052 84.8514C608.115 83.6934 610.252 82.3914 610.802 81.9584C611.352 81.5254 613.49 80.2234 615.552 79.0654C617.615 77.9064 620.99 75.9854 623.052 74.7964C628.26 71.7934 640.997 65.0704 645.802 62.7874C648.002 61.7424 650.477 60.4794 651.302 59.9814C653.83 58.4554 655.755 58.8534 657.237 61.2084ZM233.802 164.311C222.072 170.579 216.671 173.831 206.302 180.868C200.527 184.787 191.302 190.959 185.802 194.584C180.302 198.209 174.583 202.026 173.092 203.066C171.602 204.107 170.131 204.958 169.823 204.958C169.514 204.958 167.584 206.012 165.532 207.3C163.481 208.589 159.102 211.132 155.802 212.953C140.296 221.507 134.593 227.683 128.094 242.958C121.731 257.914 120.384 266.898 120.337 294.694C120.3 316.969 119.796 320.824 115.417 332.324C113.345 337.764 111.998 339.738 108.931 341.824C97.4918 349.606 87.5058 355.199 65.8018 365.979C44.1298 376.743 34.3908 382.182 22.6228 390.094C17.0768 393.823 3.70782 407.278 1.67182 411.18C-0.584181 415.505 -0.551181 427.702 1.73582 434.458C4.21082 441.769 16.5828 466.414 30.6018 491.958C32.5638 495.533 35.4218 500.933 36.9538 503.958C38.4848 506.983 41.2648 512.158 43.1318 515.458C44.9978 518.758 48.3218 524.833 50.5198 528.958C52.7168 533.083 55.1418 537.168 55.9088 538.037C56.6748 538.905 57.3018 539.883 57.3018 540.21C57.3018 540.538 59.6638 544.681 62.5518 549.418C65.4398 554.155 68.2518 558.802 68.8018 559.744C69.6368 561.174 78.4448 574.327 85.0178 583.958C85.9558 585.333 87.9678 588.033 89.4888 589.958C91.0098 591.883 93.9518 595.605 96.0278 598.23C102.993 607.037 117.738 622.783 124.98 629.149C141.083 643.303 143.66 644.067 156.425 638.48C161.032 636.464 167.502 633.33 170.802 631.517C174.102 629.704 179.052 626.986 181.802 625.478C186.182 623.075 206.128 611.159 212.802 606.958C228.595 597.016 255.794 581.288 263.355 577.725C275.546 571.981 281.273 569.591 284.802 568.774C311.536 562.589 320.921 561.938 396.802 561.005C468.723 560.121 472.2 559.871 487.802 554.462C494.222 552.236 497.312 550.642 505.361 545.405C519.069 536.486 528.043 523.367 531.374 507.375C534.516 492.295 539.69 486.91 557.793 479.877C562.198 478.166 569.115 475.47 573.164 473.885C580.974 470.829 589.392 465.693 592.959 461.808C600.151 453.976 602.124 441.485 602.235 403.101L602.302 379.744L605.389 373.275C608.555 366.642 614.156 359.625 628.578 344.224C637.779 334.399 638.299 333.688 641.944 325.958C644.493 320.552 644.526 320.193 643.904 304.958C643.556 296.433 642.872 285.183 642.384 279.958C641.572 271.264 641.059 268.049 638.424 255.129C637.3 249.614 632.485 244.465 625.523 241.333L620.245 238.958H534.447C458.103 238.958 433.747 239.516 424.683 241.473C421.973 242.058 421.428 245.84 420.221 272.458C418.58 308.614 415.924 324.188 408.299 342.369C404.88 350.521 398.198 361.312 393.485 366.293C385.437 374.796 362.857 385.687 344.802 389.773C333.051 392.432 314.519 392.14 302.878 389.111C295.995 387.32 284.033 380.786 278.962 376.047C264.732 362.749 250.245 329.052 245.389 297.958C240.896 269.182 240.528 257.294 242.112 191.958C242.78 164.394 242.569 160.784 240.302 161.047C240.027 161.078 237.102 162.547 233.802 164.311ZM190.267 271.458C191.664 292.084 193.325 302.28 199.412 327.598C205.43 352.626 213.38 373.488 221.518 385.603C223.049 387.883 224.302 390.025 224.302 390.363C224.302 391.863 235.653 405.98 240.956 411.074C248.329 418.157 263.938 429.276 271.123 432.562C282.374 437.708 311.534 443.952 324.302 443.948C337.591 443.944 370.566 437.029 385.302 431.156C400.683 425.026 417.687 414.388 428.651 404.036C434.265 398.736 444.614 385.137 448.878 377.458C449.489 376.358 450.918 373.83 452.054 371.84C455.792 365.293 461.027 349.684 464.088 335.958C468.668 315.428 469.069 313.236 470.369 301.684L471.576 290.958H531.335H591.094L591.802 298.957L592.51 306.956L586.303 313.957C582.889 317.807 579.752 320.958 579.331 320.958C578.561 320.958 564.045 340.366 561.363 344.981C557.818 351.08 556.176 355.469 553.643 365.606C551.153 375.571 550.904 378.378 550.596 399.958C550.411 412.883 550.055 424.395 549.804 425.54C549.451 427.153 546.524 428.728 536.795 432.54C520.077 439.09 504.576 449.933 496.123 460.991C492.984 465.098 490.39 468.839 490.359 469.304C490.328 469.769 489.407 471.406 488.314 472.942C487.22 474.477 485.228 480.268 483.886 485.81C482.544 491.351 480.848 497.139 480.118 498.672C478.391 502.294 469.026 506.859 460.914 508.033C457.552 508.52 429.152 508.928 397.802 508.941C330.574 508.969 316.633 509.9 284.826 516.482C259.842 521.652 246.74 526.895 219.052 542.803C216.99 543.988 213.615 545.911 211.552 547.075C209.49 548.239 206.608 550.039 205.148 551.075C203.688 552.111 202.201 552.958 201.843 552.958C201.485 552.958 198.542 554.758 195.302 556.958C192.062 559.158 189.137 560.958 188.802 560.958C188.467 560.958 185.542 562.758 182.302 564.958C179.062 567.158 176.119 568.958 175.761 568.958C175.403 568.958 173.916 569.805 172.456 570.841C170.996 571.877 168.115 573.677 166.052 574.841C157.414 579.717 155.479 580.831 153.618 581.993C151.878 583.079 151.081 582.605 146.495 577.756C143.655 574.753 140.087 570.672 138.567 568.689C126.731 553.246 124.125 549.732 120.457 544.263C118.172 540.856 116.302 537.851 116.302 537.586C116.302 537.321 114.052 533.707 111.302 529.555C108.552 525.402 106.302 521.737 106.302 521.411C106.302 521.085 105.051 518.937 103.521 516.638C101.992 514.339 100.096 511.108 99.3068 509.458C98.5188 507.808 97.0178 505.19 95.9718 503.641C94.9268 502.092 91.9478 496.692 89.3528 491.641C86.7588 486.59 83.5828 480.658 82.2958 478.458C81.0088 476.258 76.9618 468.608 73.3018 461.458C69.6418 454.308 65.5998 446.658 64.3198 444.458C60.4368 437.783 56.2408 429.685 56.5298 429.421C57.6448 428.404 68.3618 422.777 89.8018 411.948C122.004 395.685 121.926 395.73 140.086 382.645C146.364 378.121 149.772 374.712 154.159 368.567C161.904 357.72 163.752 353.386 167.991 336.127C171.508 321.805 171.609 320.843 172.257 295.458C172.865 271.636 173.104 269.067 175.101 264.787C176.36 262.088 178.446 259.506 180.041 258.673C181.56 257.88 184.152 256.5 185.802 255.607C187.452 254.714 188.888 254.315 188.993 254.72C189.098 255.126 189.672 262.658 190.267 271.458Z"/></svg>';

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

const extractArtistIdFromUri = (uri: string) => {
  const normalizedUri = uri.trim();
  const parsedUri = Spicetify?.URI?.from?.(normalizedUri);
  if (parsedUri?.type === Spicetify?.URI?.Type?.ARTIST && typeof parsedUri.id === "string") {
    return parsedUri.id;
  }

  const matches = [
    /^spotify:artist:([A-Za-z0-9]+)(?:[?:#].*)?$/i.exec(normalizedUri),
    /^https?:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]+)(?:\?.*)?$/i.exec(normalizedUri)
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

const extractUserIdFromUri = (uri: string) => {
  const normalizedUri = uri.trim();
  const matches = [
    /^spotify:user:([^?:#]+)(?:[?:#].*)?$/i.exec(normalizedUri),
    /^https?:\/\/open\.spotify\.com\/user\/([^/?#]+)(?:\?.*)?$/i.exec(normalizedUri)
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
const buildSpotifyArtistUri = (artistId: string) => `${ARTIST_URI_PREFIX}${artistId}`;
const buildSpotifyUserUri = (userId: string) => `${USER_URI_PREFIX}${userId}`;

const normalizeArtistUri = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const artistId = extractArtistIdFromUri(value);
  return artistId ? buildSpotifyArtistUri(artistId) : null;
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
  (typeof artist?.id === "string" && artist.id.length ? buildSpotifyArtistUri(artist.id) : null) ??
  getMetadataArtistUri(metadata);

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
    .flatMap((definition: any) =>
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

const openSpotifyRoute = (path: string, fallbackUrl: string) => {
  try {
    const history = Spicetify?.Platform?.History;
    if (typeof history?.push === "function") {
      history.push(path);
      return;
    }
  } catch {
    // Ignore History API failures and fall back to the web URL.
  }

  window.open(fallbackUrl, "_blank", "noopener,noreferrer");
};

const openTrackPage = (trackUri: string | null | undefined) => {
  if (!trackUri) {
    return;
  }

  const trackId = extractTrackIdFromUri(trackUri);
  if (!trackId) {
    return;
  }

  window.open(`${TRACK_URL_PREFIX}${trackId}`, "_blank", "noopener,noreferrer");
};

const openArtistPage = (artistUri: string | null | undefined) => {
  if (!artistUri) {
    return;
  }

  const artistId = extractArtistIdFromUri(artistUri);
  if (!artistId) {
    return;
  }

  openSpotifyRoute(`/artist/${artistId}`, `${ARTIST_URL_PREFIX}${artistId}`);
};

const openProfilePage = (profileUri: string | null | undefined) => {
  if (!profileUri) {
    return;
  }

  const userId = extractUserIdFromUri(profileUri);
  if (!userId) {
    return;
  }

  openSpotifyRoute(`/user/${userId}`, `${USER_URL_PREFIX}${userId}`);
};

const openArtistSearchPage = (artistName: string | null | undefined) => {
  const normalizedArtistName = artistName?.trim();
  if (!normalizedArtistName) {
    return;
  }

  const encodedArtistName = encodeURIComponent(normalizedArtistName);
  openSpotifyRoute(`/search/${encodedArtistName}/artists`, `${SEARCH_URL_PREFIX}${encodedArtistName}/artists`);
};

const artistUriByTrackCache = new Map<string, Promise<string | null> | string | null>();

const getPrimaryArtistUriForTrack = async (trackUri: string | null | undefined) => {
  if (!trackUri) {
    return null;
  }

  const trackId = extractTrackIdFromUri(trackUri);
  if (!trackId) {
    return null;
  }

  const cached = artistUriByTrackCache.get(trackId);
  if (typeof cached === "string" || cached === null) {
    return cached;
  }

  if (cached) {
    return cached;
  }

  const pending = (async () => {
    try {
      const track = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`);
      const artistId = typeof track?.artists?.[0]?.id === "string" ? track.artists[0].id : null;
      return artistId ? buildSpotifyArtistUri(artistId) : null;
    } catch {
      return null;
    }
  })();

  artistUriByTrackCache.set(trackId, pending);
  const resolved = await pending;
  artistUriByTrackCache.set(trackId, resolved);
  return resolved;
};

const openArtistPageForTrack = async (options: {
  artistUri?: string | null;
  trackUri?: string | null;
  artistName?: string | null;
}) => {
  if (options.artistUri) {
    openArtistPage(options.artistUri);
    return;
  }

  const artistUri = await getPrimaryArtistUriForTrack(options.trackUri);
  if (!artistUri) {
    openArtistSearchPage(options.artistName);
    return;
  }

  openArtistPage(artistUri);
};

const extractSpotifyAvatarUrl = (user: any) =>
  user?.avatarUrl ??
  user?.imageUrl ??
  user?.images?.[0]?.url ??
  user?.avatar?.url ??
  user?.photo_url ??
  null;

const extractSpotifyDisplayName = (user: any) => user?.displayName ?? user?.display_name ?? user?.name ?? null;

const extractSpotifyProfileUri = (user: any) =>
  (typeof user?.uri === "string" && user.uri.length ? user.uri : null) ??
  (typeof user?.id === "string" && user.id.length ? buildSpotifyUserUri(user.id) : null) ??
  (typeof user?.username === "string" && user.username.length ? buildSpotifyUserUri(user.username) : null);

const readSpotifyProfile = async () => {
  let displayName: string | null = null;
  let avatarUrl: string | null = null;
  let profileUri: string | null = null;

  try {
    const user = await Spicetify.Platform.UserAPI.getUser();
    displayName = extractSpotifyDisplayName(user);
    avatarUrl = extractSpotifyAvatarUrl(user);
    profileUri = extractSpotifyProfileUri(user);
  } catch {
    // Ignore UserAPI failures and try the Web API next.
  }

  if (displayName && avatarUrl && profileUri) {
    return { displayName, avatarUrl, profileUri };
  }

  try {
    const me = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me");
    return {
      displayName: displayName ?? me?.display_name ?? null,
      avatarUrl: avatarUrl ?? me?.images?.[0]?.url ?? null,
      profileUri: profileUri ?? extractSpotifyProfileUri(me)
    };
  } catch {
    return { displayName, avatarUrl, profileUri };
  }
};

const syncProfileFromSpotify = async () => {
  try {
    const profile = await readSpotifyProfile();
    if (!profile.displayName && !profile.avatarUrl && !profile.profileUri) {
      return;
    }

    if (profile.displayName) {
      writeSpicetifyStorage(LOCAL_STORAGE_KEYS.displayName, profile.displayName);
    }

    if (profile.avatarUrl) {
      writeSpicetifyStorage(LOCAL_STORAGE_KEYS.profileImageUrl, profile.avatarUrl);
    }

    if (profile.profileUri) {
      writeSpicetifyStorage(LOCAL_STORAGE_KEYS.profileUri, profile.profileUri);
    }

    store.setState((state) => ({
      ...state,
      displayName: profile.displayName ?? state.displayName,
      profileImageUrl: profile.avatarUrl ?? state.profileImageUrl,
      profileUri: profile.profileUri ?? state.profileUri
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
      : Array.isArray(track?.firstArtist?.items)
        ? track.firstArtist.items
        : track?.artists ? [track.artists] : [];
  const album = track?.album ?? track?.albumOfTrack ?? null;
  const images = Array.isArray(album?.images)
    ? album.images
    : Array.isArray(track?.images)
      ? track.images
      : Array.isArray(track?.coverArt?.sources)
        ? track.coverArt.sources
        : [];
  const metadata = track?.metadata && typeof track.metadata === "object" ? (track.metadata as Record<string, unknown>) : null;

  return {
    trackUri: rawUri,
    artistUri: resolveArtistUri(artists[0] ?? track?.artist ?? track?.firstArtist, metadata),
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
      isMeaningfulTrackText(track.title, UNKNOWN_TRACK_TITLE) &&
      isMeaningfulTrackText(track.artist, UNKNOWN_TRACK_ARTIST)
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
    artistUri: getMetadataArtistUri(metadata),
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
          : Array.isArray(value?.firstArtist?.items)
            ? value.firstArtist.items
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
      artistUri: normalizeArtistUri(payload?.author_url),
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

  let fallbackSummary: SessionTrack | null = null;
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
      if (summary) {
        if (isMeaningfulTrackText(summary.artist, UNKNOWN_TRACK_ARTIST)) return summary;
        fallbackSummary = summary;
      }
    } catch (error) {
       // ignore query failure, try next
    }
  }

  return fallbackSummary;
};

const fetchTrackSummaryFromOfficialToken = async (uri: string, trackId: string): Promise<SessionTrack | null> => {
  try {
    const response = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`);
    if (response) {
      const summary = resolveTrackSummaryFromResponse(response, trackId);
      if (summary) return summary;
    }
  } catch (error) {
    // ignore
  }
  return null;
};

const fetchTrackSummaryByUri = async (uri: string): Promise<SessionTrack | null> => {
  const trackId = extractTrackIdFromUri(uri);
  if (!trackId) return null;

  let summary = await fetchTrackSummaryFromGraphQL(trackId);
  if (summary && isMeaningfulTrackText(summary.artist, UNKNOWN_TRACK_ARTIST)) return summary;

  const tokenSummary = await fetchTrackSummaryFromOfficialToken(uri, trackId);
  if (tokenSummary && isMeaningfulTrackText(tokenSummary.artist, UNKNOWN_TRACK_ARTIST)) return tokenSummary;
  
  if (!summary) summary = tokenSummary;

  if (summary && isMeaningfulTrackText(summary.artist, UNKNOWN_TRACK_ARTIST)) return summary;

  const oembedSummary = await fetchTrackSummaryFromOEmbed(trackId);
  if (oembedSummary && isMeaningfulTrackText(oembedSummary.artist, UNKNOWN_TRACK_ARTIST)) return oembedSummary;
  
  return summary ?? oembedSummary;
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
  return decoratedTracks.concat(
    fallbackTracks.filter((track): track is SessionTrack => 
      Boolean(track && extractTrackIdFromUri(track.trackUri) && isMeaningfulTrackText(track.title, UNKNOWN_TRACK_TITLE))
    )
  );
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

type NavigationHandler = () => void | Promise<void>;

const handleNavigationClick =
  (navigate: NavigationHandler) =>
  (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    void navigate();
  };

const renderNavigableText = (
  label: string,
  navigate?: NavigationHandler | null,
  options: {
    title?: string;
  } = {}
) =>
  navigate
    ? h(
        "button",
        {
          type: "button",
          className: "together-nav-link",
          onClick: handleNavigationClick(navigate),
          title: options.title ?? label
        },
        label
      )
    : label;

const renderParticipantSummary = (
  participant: ParticipantSummary,
  isSelf: boolean,
  presence: ParticipantPresence,
  profileUri: string | null
) =>
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
        renderNavigableText(
          `${participant.name}${isSelf ? " (você)" : ""}`,
          profileUri ? () => openProfilePage(profileUri) : null,
          {
            title: profileUri ? `Abrir perfil de ${participant.name}` : participant.name
          }
        )
      ),
      h(
        "span",
        { className: `together-member-chip__meta is-${presence}` },
        formatRelativeTime(participant.joinedAt)
      )
    )
  );

const renderQueueRow = (
  item: SessionQueueItem,
  index: number,
  addedBy:
    | {
        name: string;
        profileUri: string | null;
      }
    | null,
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
        h(
          "strong",
          { className: "together-queue-row__title" },
          renderNavigableText(item.title, () => openTrackPage(item.trackUri), {
            title: `Abrir faixa ${item.title}`
          })
        ),
        h(
          "span",
          { className: "together-queue-row__artist" },
          renderNavigableText(
            item.artist,
            () => openArtistPageForTrack({ artistUri: item.artistUri, trackUri: item.trackUri, artistName: item.artist }),
            {
            title: `Abrir artista ${item.artist}`
            }
          )
        )
      )
    ),
    h(
      "span",
      { className: "together-queue-row__added" },
      renderNavigableText(addedBy?.name ?? "alguém", addedBy?.profileUri ? () => openProfilePage(addedBy.profileUri) : null, {
        title: addedBy?.profileUri ? `Abrir perfil de ${addedBy.name}` : addedBy?.name ?? "alguém"
      })
    ),
    h("span", { className: "together-queue-row__duration" }, formatDuration(item.durationMs)),
    h(
      "button",
      {
        className: "together-icon-button together-icon-button--danger",
        onClick: () => onRemove(item.id),
        type: "button",
        title: `Remover ${item.title} da fila`,
        "aria-label": `Remover ${item.title} da fila`
      },
      h(
        "svg",
        {
          className: "together-icon-button__icon",
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true"
        },
        h("path", {
          d: "M4 4L12 12M12 4L4 12",
          stroke: "currentColor",
          "stroke-width": "1.9",
          "stroke-linecap": "round"
        })
      )
    )
  );

const renderLyricsLine = (
  line: NonNullable<TrackLyricsPayload["lines"]>[number],
  index: number,
  activeIndex: number,
  refs: { current: Record<number, HTMLDivElement | null> }
) => {
  const distanceFromActive = activeIndex < 0 ? null : Math.abs(index - activeIndex);
  const depthClass =
    distanceFromActive == null
      ? ""
      : distanceFromActive === 0
        ? " is-active"
        : distanceFromActive === 1
          ? " is-near"
          : distanceFromActive <= 3
            ? " is-mid"
            : " is-far";
  const directionClass =
    activeIndex < 0 || index === activeIndex ? "" : index < activeIndex ? " is-past" : " is-future";

  return h(
    "div",
    {
      key: `${line.timeMs ?? "plain"}-${index}`,
      ref: (node: HTMLDivElement | null) => {
        refs.current[index] = node;
      },
      className: `together-lyrics-line${depthClass}${directionClass}${line.timeMs == null ? " is-plain" : ""}`
    },
    h("p", { className: "together-lyrics-line__text" }, line.text),
    line.translation ? h("p", { className: "together-lyrics-line__translation" }, line.translation) : null
  );
};

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
  const [updateUrl, setUpdateUrl] = useState(null as string | null);
  const [newVersion, setNewVersion] = useState(null as string | null);

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
  const [lyricsPayload, setLyricsPayload] = useState(null as TrackLyricsPayload | null);
  const [lyricsStatus, setLyricsStatus] = useState("idle" as "idle" | "loading" | "ready" | "error");
  const [lyricsDetached, setLyricsDetached] = useState(false);
  const lyricsViewportRef = useRef(null as HTMLDivElement | null);
  const lyricsLineRefs = useRef({} as Record<number, HTMLDivElement | null>);
  const lyricsProgrammaticScrollUntilRef = useRef(0);

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
  const activeLyricsIndex = useMemo(
    () => findActiveLyricsLineIndex(lyricsPayload?.lines ?? [], displayPosition),
    [displayPosition, lyricsPayload]
  );
  const participantById = useMemo(
    () =>
      Object.fromEntries(state.participants.map((participant) => [participant.memberId, participant])) as Record<
        string,
        ParticipantSummary
      >,
    [state.participants]
  );
  const nextUpTrack = state.queue[0] ?? null;
  const roomCodeWasCopied = Boolean(state.roomCode) && clock - lastCopiedAt < 1800;
  const isInRoom = Boolean(state.roomCode);
  const canReconnectRoom = isInRoom && !state.socketConnected && state.connectionStatus !== "connecting";
  const showLyricsSyncButton = lyricsDetached && lyricsPayload?.type === "synced";

  const markLyricsProgrammaticScroll = (durationMs: number) => {
    lyricsProgrammaticScrollUntilRef.current = Math.max(
      lyricsProgrammaticScrollUntilRef.current,
      Date.now() + durationMs
    );
  };

  const syncLyricsViewport = (behavior: ScrollBehavior = "smooth") => {
    if (lyricsPayload?.type !== "synced") {
      return;
    }

    const viewport = lyricsViewportRef.current;
    if (!viewport) {
      return;
    }

    markLyricsProgrammaticScroll(behavior === "smooth" ? 1600 : 220);
    if (activeLyricsIndex < 0) {
      viewport.scrollTo({
        top: 0,
        behavior
      });
      return;
    }

    const activeLine = lyricsLineRefs.current[activeLyricsIndex];
    if (!activeLine) {
      return;
    }

    const targetScrollTop = activeLine.offsetTop - viewport.clientHeight / 2 + activeLine.clientHeight / 2;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTo({
      top: clamp(targetScrollTop, 0, maxScrollTop),
      behavior
    });
  };

  const handleLyricsViewportScroll = () => {
    if (lyricsPayload?.type !== "synced") {
      return;
    }

    const now = Date.now();
    if (now < lyricsProgrammaticScrollUntilRef.current) {
      lyricsProgrammaticScrollUntilRef.current = now + 180;
      return;
    }

    if (!lyricsDetached) {
      setLyricsDetached(true);
    }
  };

  useEffect(() => {
    setLyricsDetached(false);
    lyricsProgrammaticScrollUntilRef.current = 0;
  }, [currentTrack?.trackUri]);

  useEffect(() => {
    if (!currentTrack) {
      setLyricsPayload(null);
      setLyricsStatus("idle");
      lyricsLineRefs.current = {};
      return;
    }

    let cancelled = false;
    setLyricsStatus("loading");

    fetchTrackLyrics(state.backendBaseUrl, {
      title: currentTrack.title,
      artist: currentTrack.artist
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }

        setLyricsPayload(payload);
        setLyricsStatus("ready");
        lyricsLineRefs.current = {};
      })
      .catch((error) => {
        console.warn("[Together] Falha ao carregar a letra da faixa.", {
          currentTrack,
          url: buildLyricsLookupUrl(state.backendBaseUrl, {
            title: currentTrack.title,
            artist: currentTrack.artist
          }),
          error
        });
        if (cancelled) {
          return;
        }

        setLyricsPayload(null);
        setLyricsStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.trackUri, currentTrack?.title, currentTrack?.artist, state.backendBaseUrl]);

  useEffect(() => {
    if (lyricsDetached) {
      return;
    }

    syncLyricsViewport("smooth");
  }, [activeLyricsIndex, lyricsDetached, lyricsPayload?.type, lyricsPayload?.trackName]);

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
        false && updateUrl && newVersion
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
              h(
                "h1",
                { className: "together-playback-card__title" },
                currentTrack
                  ? renderNavigableText(currentTrack.title, () => openTrackPage(currentTrack.trackUri), {
                      title: `Abrir faixa ${currentTrack.title}`
                    })
                  : "Nenhuma faixa sincronizada"
              ),
              h(
                "p",
                { className: "together-playback-card__artist" },
                currentTrack
                  ? [
                      renderNavigableText(
                        currentTrack.artist,
                        () =>
                          openArtistPageForTrack({
                            artistUri: currentTrack.artistUri,
                            trackUri: currentTrack.trackUri,
                            artistName: currentTrack.artist
                          }),
                        {
                        title: `Abrir artista ${currentTrack.artist}`
                        }
                      ),
                      currentTrack.album ? ` • ${currentTrack.album}` : null
                    ]
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
                    h(
                      "strong",
                      { className: "together-next-up__title" },
                      renderNavigableText(nextUpTrack.title, () => openTrackPage(nextUpTrack.trackUri), {
                        title: `Abrir faixa ${nextUpTrack.title}`
                      })
                    ),
                    h(
                      "span",
                      { className: "together-next-up__artist" },
                      renderNavigableText(
                        nextUpTrack.artist,
                        () =>
                          openArtistPageForTrack({
                            artistUri: nextUpTrack.artistUri,
                            trackUri: nextUpTrack.trackUri,
                            artistName: nextUpTrack.artist
                          }),
                        {
                        title: `Abrir artista ${nextUpTrack.artist}`
                        }
                      )
                    )
                  )
                )
              : h("span", { className: "together-next-up__empty" }, "Fila vazia")
          )
        ),
        h(
          "section",
          { className: "together-panel together-panel--lyrics" },
          h(
            "div",
            { className: "together-panel__header" },
            h("h2", { className: "together-panel__title" }, "Letra"),
          ),
          !currentTrack
            ? h("div", { className: "together-empty together-empty--lyrics" }, "Reproduza uma faixa para carregar a letra.")
            : lyricsStatus === "loading"
              ? h("div", { className: "together-empty together-empty--lyrics" }, "Carregando letra...")
              : lyricsStatus === "error"
                ? h("div", { className: "together-empty together-empty--lyrics" }, "Não foi possível carregar a letra.")
                : lyricsPayload?.type === "instrumental"
                  ? h("div", { className: "together-empty together-empty--lyrics" }, "Faixa instrumental.")
                  : lyricsPayload?.lines.length
                    ? h(
                        "div",
                        { className: "together-lyrics-card" },
                        h(
                          "div",
                          { className: "together-lyrics-card__meta" },
                          h(
                            "strong",
                            null,
                            renderNavigableText(lyricsPayload.trackName, () => openTrackPage(currentTrack.trackUri), {
                              title: `Abrir faixa ${lyricsPayload.trackName}`
                            })
                          ),
                          h(
                            "span",
                            null,
                            renderNavigableText(
                              lyricsPayload.artistName,
                              () =>
                                openArtistPageForTrack({
                                  artistUri: currentTrack.artistUri,
                                  trackUri: currentTrack.trackUri,
                                  artistName: lyricsPayload.artistName
                                }),
                              {
                              title: `Abrir artista ${lyricsPayload.artistName}`
                              }
                            )
                          )
                        ),
                        h(
                          "div",
                          {
                            className: "together-lyrics-card__viewport",
                            onScroll: handleLyricsViewportScroll,
                            ref: (node: HTMLDivElement | null) => {
                              lyricsViewportRef.current = node;
                            }
                          },
                          lyricsPayload.lines.map((line: NonNullable<TrackLyricsPayload["lines"]>[number], index: number) =>
                            renderLyricsLine(line, index, activeLyricsIndex, lyricsLineRefs)
                          )
                        ),
                        showLyricsSyncButton
                          ? h(
                              "div",
                              { className: "together-lyrics-card__sync" },
                              h(
                                "button",
                                {
                                  className: "together-button together-lyrics-sync-button",
                                  onClick: () => {
                                    setLyricsDetached(false);
                                    syncLyricsViewport("smooth");
                                  }
                                },
                                h(
                                  "span",
                                  {
                                    className: "together-lyrics-sync-button__icon",
                                    "aria-hidden": "true"
                                  },
                                  h(
                                    "svg",
                                    {
                                      viewBox: "0 0 20 20",
                                      fill: "none"
                                    },
                                    h("path", {
                                      d: "M3.25 8.25V11.75M7.25 5.75V14.25M11.25 3.75V16.25M15.25 6.75V13.25M19.25 8.75V11.25",
                                      stroke: "currentColor",
                                      strokeWidth: "2",
                                      strokeLinecap: "round"
                                    })
                                  )
                                ),
                                h("span", { className: "together-lyrics-sync-button__label" }, "Sincronizar")
                              )
                            )
                          : null
                      )
                    : h("div", { className: "together-empty together-empty--lyrics" }, "Letra não encontrada.")
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
            h("span", null, "Duração"),
            h("span", null, "")
          ),
          state.queue.length
            ? h(
                "ul",
                { className: "together-queue-list" },
                state.queue.map((item, index) => {
                  const addedByParticipant = participantById[item.addedBy];
                  const addedBy =
                    addedByParticipant != null
                      ? {
                          name: addedByParticipant.name,
                          profileUri:
                            addedByParticipant.profileUri ??
                            (addedByParticipant.memberId === state.memberId ? state.profileUri : null)
                        }
                      : item.addedBy === state.memberId
                        ? {
                            name: state.displayName,
                            profileUri: state.profileUri
                          }
                        : null;

                  return renderQueueRow(item, index, addedBy, removeQueueItem);
                })
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
          updateUrl && newVersion
            ? h(
                "button",
                {
                  className: "together-session-update",
                  onClick: () => window.open(updateUrl, "_blank", "noopener,noreferrer"),
                  type: "button",
                  title: `Baixar ${newVersion} no GitHub`
                },
                h(
                  "div",
                  { className: "together-session-update__copy" },
                  h("span", { className: "together-session-update__eyebrow" }, "Nova versão disponível"),
                  h("strong", { className: "together-session-update__title" }, newVersion)
                ),
                h("span", { className: "together-session-update__action" }, "Baixar no GitHub")
              )
            : null,
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
          h(
            "div",
            { className: "together-session-section" },
            h(
              "div",
              { className: "together-session-section__header" },
              h("h3", { className: "together-session-section__title" }, "Conectados"),
              h("span", { className: "together-panel__count" }, `${state.participants.length}`)
            ),
            state.participants.length
              ? h(
                  "ul",
                  { className: "together-member-list together-member-list--session" },
                  state.participants.map((participant) => {
                    const isSelf = participant.memberId === state.memberId;
                    return renderParticipantSummary(
                      participant,
                      isSelf,
                      resolveParticipantPresence(participant, {
                        isSelf,
                        socketConnected: state.socketConnected,
                        connectionStatus: state.connectionStatus
                      }),
                      participant.profileUri ?? (isSelf ? state.profileUri : null)
                    );
                  })
                )
              : h("div", { className: "together-empty together-empty--members" }, "Nenhum participante")
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
