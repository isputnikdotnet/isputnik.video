// What folder and file names say (names.ts), tidy and as downloads arrive.
import { describe, expect, it } from "vitest";
import { episodeFromFile, episodeTitleFromFile, parseFolderName, seasonFromFolder, sortTitle } from "../src/names.js";

describe("parseFolderName", () => {
  it("reads the tidy layout, with an id tag", () => {
    expect(parseFolderName("Radar (2026) [imdbid-tt33022834]")).toEqual({ title: "Radar", year: 2026, imdbId: "tt33022834", tmdbId: null });
    expect(parseFolderName("Counterpart (2017)")).toEqual({ title: "Counterpart", year: 2017, imdbId: null, tmdbId: null });
    expect(parseFolderName("Some Film (2010) [tmdbid-12345]")).toMatchObject({ title: "Some Film", year: 2010, tmdbId: "12345" });
  });

  it("makes sense of a release name", () => {
    expect(parseFolderName("Counterpart.S02.1080p.Wanterlude")).toMatchObject({ title: "Counterpart", year: null });
    expect(parseFolderName("Radar.S01.2026.WEB-DL.1080p.ExKinoRay")).toMatchObject({ title: "Radar" });
    expect(parseFolderName("The.Bureau.2015.1080p.BluRay")).toMatchObject({ title: "The Bureau", year: 2015 });
  });

  it("keeps a title that is only a year", () => {
    expect(parseFolderName("1917 (2019)")).toMatchObject({ title: "1917", year: 2019 });
  });
});

describe("seasons and episodes", () => {
  it("reads season folders in several languages", () => {
    expect(seasonFromFolder("Season 01")).toBe(1);
    expect(seasonFromFolder("S2")).toBe(2);
    expect(seasonFromFolder("Сезон 3")).toBe(3);
    expect(seasonFromFolder("Specials")).toBe(0);
    expect(seasonFromFolder("Extras")).toBeNull();
  });

  it("reads episode numbers in the usual shapes", () => {
    expect(episodeFromFile("Radar (2026) S01E01 - Серия 1.mkv")).toEqual({ season: 1, episode: 1 });
    expect(episodeFromFile("Radar.S01.E09.2026.WEB-DL.1080p.ExKinoRay.mkv")).toEqual({ season: 1, episode: 9 });
    expect(episodeFromFile("counterpart.s01e10.WEBRip.mkv")).toEqual({ season: 1, episode: 10 });
    expect(episodeFromFile("Show 2x05 Name.mkv")).toEqual({ season: 2, episode: 5 });
    expect(episodeFromFile("Show 1080p.mkv")).toBeNull();
  });

  it("finds the title after the number", () => {
    expect(episodeTitleFromFile("Counterpart (2017) S01E09 - No Man's Land, Part One.mkv")).toBe("No Man's Land, Part One");
    expect(episodeTitleFromFile("Counterpart.S02E01.Inside.Out.mkv")).toBeNull();
  });

  it("sorts without a leading article", () => {
    expect(sortTitle("The Bureau")).toBe("bureau");
  });
});
