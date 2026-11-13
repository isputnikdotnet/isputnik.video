// A fake video library shaped like a big real one, for bench-scan.mjs: a
// Movies folder of 2000 film folders side by side, each a tiny .mkv with a
// movie.nfo naming its cast, and a Shows folder of 50 shows x 5 seasons x 10
// episodes. The files are a few bytes: a scan only lists, stats and reads .nfo
// files, so this is all it sees of a library. Dated an hour ago, so a scan
// counts them as settled. The same library every time (a fixed seed).
//
//   node scripts/fake-library.mjs <folder> [films=2000] [shows=50]
//
// The folder is emptied first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEASONS = 5;
const EPISODES = 10;
/** Distinct names to cast from, across the whole library. */
const PEOPLE = 4000;

export function makeFakeLibrary(root, { films = 2000, shows = 50 } = {}) {
  const hourAgo = new Date(Date.now() - 3600_000);
  let seed = 42;
  const pick = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    // The high bits: the low ones of this generator repeat every few calls.
    return Math.floor((seed / 2147483648) * n);
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, hourAgo, hourAgo);
  };
  const cast = (count) => Array.from({ length: count }, (_, at) => `<actor><name>Actor ${pick(PEOPLE)}</name><role>Role ${at + 1}</role></actor>`).join("");
  const pad = (n, width = 4) => String(n).padStart(width, "0");

  fs.rmSync(root, { recursive: true, force: true });
  for (let n = 1; n <= films; n++) {
    const year = 1950 + pick(75);
    const name = `Film ${pad(n)} (${year})`;
    const dir = path.join(root, "Movies", name);
    write(path.join(dir, `${name}.mkv`), "x".repeat(1000 + pick(1000)));
    write(path.join(dir, "movie.nfo"), `<?xml version="1.0" encoding="utf-8"?>
<movie><title>Film ${pad(n)}</title><year>${year}</year><plot>A film.</plot><genre>Drama</genre>${cast(8 + pick(3))}<director>Director ${pick(400)}</director><credits>Writer ${pick(600)}</credits></movie>`);
    // Every tenth film has a trailer beside it, which is not a film of its own.
    if (n % 10 === 0) write(path.join(dir, "trailer.mkv"), "x".repeat(50));
  }
  let episodes = 0;
  for (let s = 1; s <= shows; s++) {
    const show = path.join(root, "Shows", `Show ${pad(s, 3)} (${2000 + (s % 25)})`);
    write(path.join(show, "tvshow.nfo"), `<tvshow><title>Show ${pad(s, 3)}</title>${cast(10)}</tvshow>`);
    for (let season = 1; season <= SEASONS; season++) {
      for (let e = 1; e <= EPISODES; e++) {
        write(path.join(show, `Season ${pad(season, 2)}`, `Show ${pad(s, 3)} S${pad(season, 2)}E${pad(e, 2)}.mkv`), "x".repeat(500));
        episodes += 1;
      }
    }
  }
  return { films, shows, episodes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, films = "2000", shows = "50"] = process.argv.slice(2);
  if (!root) {
    console.error("usage: node scripts/fake-library.mjs <folder> [films=2000] [shows=50]");
    process.exit(1);
  }
  const made = makeFakeLibrary(path.resolve(root), { films: Number(films), shows: Number(shows) });
  console.log(`${made.films} films and ${made.shows} shows (${made.episodes} episodes) under ${path.resolve(root)}`);
}
