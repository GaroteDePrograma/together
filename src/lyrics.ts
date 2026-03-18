import type { LyricsLine, TrackLyricsPayload } from "./protocol";

export const buildLyricsLookupUrl = (backendBaseUrl: string, track: { title: string; artist: string }) => {
  const params = new URLSearchParams({
    trackName: track.title,
    artistName: track.artist
  });
  return `${backendBaseUrl}/lyrics?${params.toString()}`;
};

export const findActiveLyricsLineIndex = (lines: LyricsLine[], playbackPositionMs: number) => {
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const lineTimeMs = lines[index]?.timeMs;
    if (typeof lineTimeMs !== "number" || lineTimeMs > playbackPositionMs) {
      break;
    }

    activeIndex = index;
  }

  return activeIndex;
};

export const fetchTrackLyrics = async (
  backendBaseUrl: string,
  track: { title: string; artist: string }
): Promise<TrackLyricsPayload> => {
  const response = await fetch(buildLyricsLookupUrl(backendBaseUrl, track));
  if (!response.ok) {
    throw new Error(`Lyrics lookup failed with status ${response.status}.`);
  }

  return response.json();
};
