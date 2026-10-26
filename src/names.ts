// What a folder or file name says about a show, a season or an episode, for
// libraries laid out the way Jellyfin and Kodi read them:
//
//   Show (Year) [imdbid-tt…]/Season 01/Show (Year) S01E01 - Title.mkv
//   Movie (Year) [tmdbid-…]/Movie (Year).mkv
//
// and, as well as can be done, the way downloads arrive before anyone tidies
// them ("Counterpart.S02.1080p.Wanterlude", "Radar.S01.E01.2026.WEB-DL…").

export interface NameFacts {
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
}

/** Release words after which nothing is part of the title any more. */
const RELEASE_TAIL = /\b(?:S\d{1,2}(?:[ ._-]?E\d{1,3})?|\d{3,4}p|WEB[- .]?(?:DL|Rip)|BluRay|BDRip|HDTV|DVDRip|x26[45]|h\.?26[45]|HEVC|AAC|AC3|DTS|REMUX|PROPER|REPACK)\b.*$/i;

export function parseFolderName(raw: string): NameFacts {
  let name = raw.trim();
  const imdb = /\[imdbid[-=](tt\d{5,10})\]/i.exec(name);
  const tmdb = /\[tmdbid[-=](\d{1,10})\]/i.exec(name);
  name = name.replace(/\[[^\]]*\]/g, " ");
  // A dotted release name has no spaces: its dots are the spaces.
  if (!/\s/.test(name) && /[._]/.test(name)) name = name.replace(/[._]+/g, " ");
  let year: number | null = null;
  const bracketYear = /\((\d{4})\)/.exec(name);
  if (bracketYear) {
    year = Number(bracketYear[1]);
    name = name.slice(0, bracketYear.index);
  } else {
    name = name.replace(RELEASE_TAIL, "");
    const looseYear = /\b(19\d{2}|20\d{2})\b\s*$/.exec(name.trim());
    if (looseYear && name.trim().length > looseYear[0].length) {
      year = Number(looseYear[1]);
      name = name.trim().slice(0, -looseYear[0].length);
    }
  }
  const title = name.replace(/\s+/g, " ").replace(/[\s-]+$/, "").trim() || raw.trim();
  return { title, year: year && year >= 1880 && year <= 2100 ? year : null, imdbId: imdb?.[1] ?? null, tmdbId: tmdb?.[1] ?? null };
}

/** The season a folder stands for: "Season 01", "S2", "Сезон 3", "Specials" (0). */
export function seasonFromFolder(name: string): number | null {
  if (/^specials?$/i.test(name.trim())) return 0;
  const match = /^(?:season|series|staffel|saison|сезон|s)[ ._-]?(\d{1,3})\b/i.exec(name.trim());
  return match ? Number(match[1]) : null;
}

/** Season and episode from a file name: S01E02, S01.E02, s1e2, 1x02. */
export function episodeFromFile(name: string): { season: number; episode: number } | null {
  const se = /S(\d{1,3})[ ._-]?E(\d{1,3})/i.exec(name);
  if (se) return { season: Number(se[1]), episode: Number(se[2]) };
  const x = /(?:^|[^0-9])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/i.exec(name);
  if (x) return { season: Number(x[1]), episode: Number(x[2]) };
  return null;
}

/** The title an episode file carries after its number: "… S01E01 - The Crossing.mkv". */
export function episodeTitleFromFile(name: string): string | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const after = /S\d{1,3}[ ._-]?E\d{1,3}\s*-\s*(.+)$/i.exec(stem);
  return after ? after[1].trim() || null : null;
}

/** How a title sorts: without a leading article, case-folded. */
export function sortTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, "").toLocaleLowerCase();
}
