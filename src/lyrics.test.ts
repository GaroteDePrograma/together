import { describe, expect, it } from "vitest";
import type { LyricsLine } from "./protocol";
import { buildLyricsLookupUrl, findActiveLyricsLineIndex } from "./lyrics";

describe("buildLyricsLookupUrl", () => {
  it("builds the backend lookup url from track title and artist", () => {
    expect(
      buildLyricsLookupUrl("http://localhost:6767", {
        title: "Believer",
        artist: "Imagine Dragons"
      })
    ).toBe("http://localhost:6767/lyrics?trackName=Believer&artistName=Imagine+Dragons");
  });
});

describe("findActiveLyricsLineIndex", () => {
  const lines: LyricsLine[] = [
    {
      timeMs: 7570,
      text: "First things first",
      translation: "Primeiro de tudo"
    },
    {
      timeMs: 9210,
      text: "I'ma say all the words inside my head",
      translation: "Vou dizer todas as palavras dentro da minha cabeça"
    },
    {
      timeMs: 12080,
      text: "I'm fired up and tired",
      translation: "Estou aceso e cansado"
    }
  ];

  it("returns the currently active synced line for the playback position", () => {
    expect(findActiveLyricsLineIndex(lines, 9300)).toBe(1);
    expect(findActiveLyricsLineIndex(lines, 14000)).toBe(2);
  });

  it("returns -1 before the first synced line or when lines are unsynced", () => {
    expect(findActiveLyricsLineIndex(lines, 4000)).toBe(-1);
    expect(
      findActiveLyricsLineIndex(
        [
          {
            timeMs: null,
            text: "Line one",
            translation: "Linha um"
          }
        ],
        4000
      )
    ).toBe(-1);
  });
});
