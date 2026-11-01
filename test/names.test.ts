// What folder and file names say (names.ts), tidy and as downloads arrive.
import { describe, expect, it } from "vitest";
import { episodeFromFile, episodeTitleFromFile, isExtraFile, isPartFolder, parseFolderName, partFromName, seasonFromFolder, sortTitle } from "../src/names.js";

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

describe("parts of a film", () => {
  it("reads the part from the usual shapes, and what it is a part of", () => {
    expect(partFromName("Voditel avtobusa part1_HQ")).toMatchObject({ title: "Voditel avtobusa", part: 1 });
    expect(partFromName("Angélique, Marquise des Anges part-1")).toMatchObject({ title: "Angélique, Marquise des Anges", part: 1 });
    expect(partFromName("Some.Film.2010.CD2.x264")).toMatchObject({ title: "Some Film", year: 2010, part: 2 });
    expect(partFromName("Семнадцать мгновений, 2 серия")).toMatchObject({ title: "Семнадцать мгновений", part: 2 });
    expect(partFromName("Служебный роман ч.2")).toMatchObject({ title: "Служебный роман", part: 2 });
    expect(partFromName("Film part 2 (1975)")).toMatchObject({ title: "Film", year: 1975, part: 2 });
  });

  it("leaves other numbers alone", () => {
    expect(partFromName("Rocky 2")).toBeNull();
    expect(partFromName("Apart 2")).toBeNull();
    expect(partFromName("Blade Runner 2049")).toBeNull();
  });

  it("knows a folder that only names a part", () => {
    expect(isPartFolder("CD1")).toBe(true);
    expect(isPartFolder("Часть 2")).toBe(true);
    expect(isPartFolder("Film part 2")).toBe(false);
  });

  it("knows what goes with a film rather than being one", () => {
    expect(isExtraFile("trailer.mkv")).toBe(true);
    expect(isExtraFile("Some Film-trailer.mkv")).toBe(true);
    expect(isExtraFile("Extras/Interview with the director.mkv")).toBe(true);
    expect(isExtraFile("Some Film-behindthescenes.mkv")).toBe(true);
    expect(isExtraFile("The Extra.mkv")).toBe(false);
    expect(isExtraFile("Angelique and the King part-3.m4v")).toBe(false);
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
